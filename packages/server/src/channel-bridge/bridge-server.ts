import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { ChatMessage, ExecuteOptions, ProviderConfigYaml, ReasoningEffort } from '@star-cliproxy/shared';
import { ClaudeProvider } from '../providers/claude-provider.js';

// 내장 Claude Code Channel bridge.
// 외부 bridge 없이 star-cliproxy가 직접 띄울 수 있는 최소 구현으로,
// claude-channel-executor 프로토콜(POST /jobs, GET /jobs/:id, GET /health)을 따른다.
// 실제 실행은 기존 ClaudeProvider(CLI 모드)를 재사용해 로직 중복을 피한다.

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
  jobTtlMs?: number;             // 완료 job 보관 시간 (기본 5분)
}

type JobStatus = 'submitted' | 'running' | 'completed' | 'failed';

interface JobRecord {
  jobId: string;
  status: JobStatus;
  result?: string;
  usage?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const VALID_EFFORTS = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class ChannelBridge {
  private readonly opts: Required<Pick<BridgeServerOptions, 'port' | 'host' | 'timeoutMs' | 'maxConcurrent' | 'jobTtlMs'>> & BridgeServerOptions;
  private readonly provider: ClaudeProvider;
  private readonly jobs = new Map<string, JobRecord>();
  private server: Server | null = null;
  private active = 0;
  private readonly startedAt = Date.now();

  constructor(options: BridgeServerOptions) {
    this.opts = {
      host: '127.0.0.1',
      maxConcurrent: 4,
      jobTtlMs: 5 * 60_000,
      ...options,
    };

    const providerConfig: ProviderConfigYaml = {
      enabled: true,
      cli_path: options.cliPath,
      default_model: options.defaultModel,
      max_concurrent: this.opts.maxConcurrent,
      timeout_ms: options.timeoutMs,
      extra_args: options.extraArgs ?? [],
      working_dir: options.workingDir,
      mode: 'cli',
    };
    this.provider = new ClaudeProvider(providerConfig);
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
    if (this.active >= this.opts.maxConcurrent) {
      this.sendJson(res, 503, { ok: false, error: 'Bridge at capacity, retry later' });
      return;
    }

    const model = typeof body.model === 'string' && body.model ? body.model : this.opts.defaultModel;
    const reasoningEffort = typeof body.reasoning_effort === 'string' && VALID_EFFORTS.has(body.reasoning_effort as ReasoningEffort)
      ? (body.reasoning_effort as ReasoningEffort)
      : undefined;

    const messages: ChatMessage[] = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: userPrompt });

    const jobId = randomUUID();
    const now = Date.now();
    const job: JobRecord = { jobId, status: 'submitted', createdAt: now, updatedAt: now };
    this.jobs.set(jobId, job);

    // 비동기 실행 — 응답은 즉시 반환하고 executor가 status_url을 polling한다.
    void this.runJob(job, { messages, model, stream: false, reasoningEffort });

    this.sendJson(res, 202, {
      ok: true,
      job_id: jobId,
      status: 'submitted',
      status_url: `http://${this.opts.host}:${this.opts.port}/jobs/${jobId}`,
    });
  }

  private async runJob(job: JobRecord, options: ExecuteOptions): Promise<void> {
    this.active += 1;
    job.status = 'running';
    job.updatedAt = Date.now();
    try {
      const result = await this.provider.execute(options);
      job.status = 'completed';
      job.result = result.content;
      job.usage = result.usage;
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.updatedAt = Date.now();
      this.active -= 1;
      this.scheduleCleanup(job.jobId);
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
