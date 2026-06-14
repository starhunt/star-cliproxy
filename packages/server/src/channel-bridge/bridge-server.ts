import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { ReasoningEffort, TokenUsage } from '@star-cliproxy/shared';
import { runClaudeJob, type PtyJobConfig } from './pty-session.js';

// 내장 Claude Code Channel bridge.
// claude를 interactive 세션(`-p` 없음)으로 PTY 구동하고, 모델이 report_result MCP tool로
// 보낸 결과를 받아 반환한다 → `claude -p`/Agent SDK 빌링 분리를 회피한다.
// job 하나당 1회용 세션이며 동시성은 maxConcurrent로 제한. 프로토콜: POST /jobs, GET /jobs/:id, GET /health.

export interface BridgeServerOptions {
  port: number;
  host?: string;                 // 기본 127.0.0.1 (외부 노출 방지)
  apiKey?: string;               // 설정 시 Authorization: Bearer 검증
  cliPath: string;               // claude CLI 경로
  defaultModel: string;
  workingDir?: string;
  timeoutMs: number;
  extraArgs?: string[];
  maxConcurrent?: number;        // 동시 실행 job 상한 (기본 4)
  maxQueue?: number;             // 대기 큐 상한 (기본 256). 동시 실행 + 대기 합이 초과하면 503
  jobTtlMs?: number;             // 완료 job 보관 시간 (기본 5분)
}

type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

interface JobRecord {
  jobId: string;
  status: JobStatus;
  result?: string;
  usage?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

interface JobParams {
  prompt: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

const VALID_EFFORTS = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

// PTY 경로는 토큰 usage를 제공하지 않으므로 길이 기반 추정치를 반환한다.
function estimateUsage(prompt: string, content: string): TokenUsage {
  const promptTokens = Math.ceil(prompt.length / 4);
  const completionTokens = Math.ceil(content.length / 4);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class ChannelBridge {
  private readonly opts: Required<Pick<BridgeServerOptions, 'port' | 'host' | 'timeoutMs' | 'maxConcurrent' | 'maxQueue' | 'jobTtlMs'>> & BridgeServerOptions;
  private readonly ptyConfig: PtyJobConfig;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly pending: Array<{ job: JobRecord; params: JobParams }> = [];
  private server: Server | null = null;
  private active = 0;
  private readonly startedAt = Date.now();

  constructor(options: BridgeServerOptions) {
    this.opts = {
      host: '127.0.0.1',
      maxConcurrent: 4,
      maxQueue: 256,
      jobTtlMs: 5 * 60_000,
      ...options,
    };

    this.ptyConfig = {
      cliPath: options.cliPath,
      model: options.defaultModel,
      workingDir: options.workingDir,
      timeoutMs: options.timeoutMs,
      extraArgs: options.extraArgs,
    };
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          this.sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        });
      });
      server.on('error', reject);
      server.listen(this.opts.port, this.opts.host, () => {
        this.server = server;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  private authorized(req: IncomingMessage): boolean {
    if (!this.opts.apiKey) return true;
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    return safeEqual(token, this.opts.apiKey);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${this.opts.host}:${this.opts.port}`);
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      this.sendJson(res, 200, {
        ok: true,
        uptime_ms: Date.now() - this.startedAt,
        active_jobs: this.active,
        queued_jobs: this.pending.length,
        max_concurrent: this.opts.maxConcurrent,
        total_jobs: this.jobs.size,
        model: this.opts.defaultModel,
        service: 'star-cliproxy-channel-bridge',
      });
      return;
    }

    if (!this.authorized(req)) {
      this.sendJson(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    if (req.method === 'POST' && path === '/jobs') {
      await this.handleSubmit(req, res);
      return;
    }

    const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && jobMatch) {
      this.handleStatus(decodeURIComponent(jobMatch[1]), res);
      return;
    }

    this.sendJson(res, 404, { ok: false, error: `Not found: ${req.method} ${path}` });
  }

  private async handleSubmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await this.readJson(req);
    } catch (err) {
      this.sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'Invalid JSON body' });
      return;
    }

    const system = typeof body.system === 'string' ? body.system : undefined;
    // user_prompt(내장 bridge 전용)가 있으면 우선, 없으면 합쳐진 prompt 사용 (외부 bridge 호환)
    const userPrompt = typeof body.user_prompt === 'string' ? body.user_prompt
      : typeof body.prompt === 'string' ? body.prompt
        : '';
    if (!userPrompt.trim()) {
      this.sendJson(res, 400, { ok: false, error: 'prompt is required' });
      return;
    }
    // 동시 실행 + 대기 큐 합이 상한을 넘을 때만 503 (그 전까지는 큐에 쌓아둔다)
    if (this.active + this.pending.length >= this.opts.maxConcurrent + this.opts.maxQueue) {
      this.sendJson(res, 503, { ok: false, error: 'Bridge queue full, retry later' });
      return;
    }

    const model = typeof body.model === 'string' && body.model ? body.model : this.opts.defaultModel;
    const reasoningEffort = typeof body.reasoning_effort === 'string' && VALID_EFFORTS.has(body.reasoning_effort as ReasoningEffort)
      ? (body.reasoning_effort as ReasoningEffort)
      : undefined;

    // system + user를 하나의 프롬프트로 합쳐 PTY 세션에 주입한다 (report_result로 결과 회수)
    const prompt = system ? `${system}\n\n---\n\n${userPrompt}` : userPrompt;

    const jobId = randomUUID();
    const now = Date.now();
    const job: JobRecord = { jobId, status: 'queued', createdAt: now, updatedAt: now };
    this.jobs.set(jobId, job);

    // 큐에 넣고 슬롯이 비면 실행된다. 응답은 즉시 반환하고 executor가 status_url을 polling한다.
    this.schedule(job, { prompt, model, reasoningEffort });

    this.sendJson(res, 202, {
      ok: true,
      job_id: jobId,
      status: job.status, // 슬롯이 있었으면 'running', 없으면 'queued'
      status_url: `http://${this.opts.host}:${this.opts.port}/jobs/${jobId}`,
    });
  }

  // 대기 큐에 넣고 가용 슬롯만큼 실행을 펌프한다 (FIFO)
  private schedule(job: JobRecord, params: JobParams): void {
    this.pending.push({ job, params });
    this.pump();
  }

  private pump(): void {
    while (this.active < this.opts.maxConcurrent && this.pending.length > 0) {
      const next = this.pending.shift();
      if (next) void this.runJob(next.job, next.params);
    }
  }

  private async runJob(job: JobRecord, params: JobParams): Promise<void> {
    this.active += 1;
    job.status = 'running';
    job.updatedAt = Date.now();
    try {
      const extraArgs = [...(this.ptyConfig.extraArgs ?? [])];
      if (params.reasoningEffort) extraArgs.push('--effort', params.reasoningEffort);
      const result = await runClaudeJob(params.prompt, {
        ...this.ptyConfig,
        model: params.model,
        extraArgs,
      });
      job.status = result.status === 'error' ? 'failed' : 'completed';
      job.result = result.content;
      if (result.status === 'error') job.error = result.content;
      job.usage = estimateUsage(params.prompt, result.content);
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.updatedAt = Date.now();
      this.active -= 1;
      this.scheduleCleanup(job.jobId);
      this.pump(); // 슬롯이 비었으니 대기 중인 다음 job 실행
    }
  }

  private scheduleCleanup(jobId: string): void {
    const timer = setTimeout(() => this.jobs.delete(jobId), this.opts.jobTtlMs);
    timer.unref?.();
  }

  private handleStatus(jobId: string, res: ServerResponse): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      this.sendJson(res, 404, { ok: false, error: `Unknown job: ${jobId}` });
      return;
    }
    this.sendJson(res, 200, {
      ok: true,
      job_id: job.jobId,
      status: job.status,
      result: job.result,
      usage: job.usage,
      error: job.error,
    });
  }

  private readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const MAX = 8 * 1024 * 1024; // 8MB 상한
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX) {
          reject(new Error('Request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          const parsed = text ? JSON.parse(text) : {};
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            resolve(parsed as Record<string, unknown>);
          } else {
            reject(new Error('Body must be a JSON object'));
          }
        } catch {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(text);
  }
}
