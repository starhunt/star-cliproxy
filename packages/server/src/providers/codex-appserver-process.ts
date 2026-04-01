// codex app-server 프로세스 생명주기 관리 및 JSON-RPC 2.0 stdio 통신

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { CodexAppServerOptions } from '@star-cliproxy/shared';

const DEFAULT_RESTART_DELAY_MS = 1000;
const MAX_RESTART_DELAY_MS = 30000;
const INITIALIZE_TIMEOUT_MS = 10000;
const GRACEFUL_SHUTDOWN_MS = 3000;

export interface CodexAppServerProcessConfig {
  cliPath: string;
  options: CodexAppServerOptions;
  env: Record<string, string | undefined>;
  workingDir?: string;
}

// 대기 중인 JSON-RPC 요청 항목
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export class CodexAppServerProcess {
  private child: ChildProcess | null = null;
  private pendingRequests = new Map<number, PendingRequest>();
  private notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private nextRequestId = 1;
  private restartCount = 0;
  private maxRestartCount: number;
  private autoRestart: boolean;
  private starting = false;
  private stopping = false;
  private initialized = false;

  constructor(private config: CodexAppServerProcessConfig) {
    this.autoRestart = config.options.auto_restart ?? true;
    this.maxRestartCount = config.options.max_restart_count ?? 5;
  }

  // 프로세스 스폰 + 초기화 핸드셰이크
  async start(): Promise<void> {
    if (this.child || this.starting) return;
    this.starting = true;
    try {
      this.child = spawn(this.config.cliPath, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...this.config.env } as NodeJS.ProcessEnv,
        cwd: this.config.workingDir,
      });

      // stdout JSONL 라인 수신
      const rl = createInterface({ input: this.child.stdout! });
      rl.on('line', (line) => this.handleLine(line));

      // stderr 로깅
      this.child.stderr?.on('data', (data: Buffer) => {
        console.error(`[codex-appserver] stderr: ${data.toString().trim()}`);
      });

      // 프로세스 종료 핸들러
      this.child.on('exit', (code, signal) => {
        this.handleExit(code, signal);
      });
      this.child.on('error', (err) => {
        console.error('[codex-appserver] process error:', err.message);
        this.handleExit(1, null);
      });

      // 초기화 핸드셰이크 수행
      await this.initialize();
      this.restartCount = 0; // 정상 기동 시 재시작 카운터 초기화
    } finally {
      this.starting = false;
    }
  }

  // initialize → initialized 핸드셰이크 (generate-ts 스키마 기반)
  private async initialize(): Promise<void> {
    await this.request(
      'initialize',
      {
        clientInfo: { name: 'star-cliproxy', title: null, version: '1.0.0' },
        capabilities: { experimentalApi: false },
      },
      INITIALIZE_TIMEOUT_MS,
    );

    // initialized 알림 전송 (id 없음 = 알림, 응답 불필요)
    this.sendNotification('initialized');
    this.initialized = true;
  }

  // 정상 종료
  async stop(): Promise<void> {
    this.stopping = true;
    this.autoRestart = false;

    if (!this.child) {
      this.stopping = false;
      return;
    }

    // 대기 중인 요청 전부 거부
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('App server shutting down'));
      this.pendingRequests.delete(id);
    }

    const child = this.child;
    this.child = null;
    this.initialized = false;

    return new Promise<void>((resolve) => {
      // GRACEFUL_SHUTDOWN_MS 초과 시 강제 종료
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 이미 종료된 경우 무시 */
        }
        resolve();
      }, GRACEFUL_SHUTDOWN_MS);

      child.once('exit', () => {
        clearTimeout(killTimer);
        this.stopping = false;
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        /* 이미 종료된 경우 무시 */
      }
    });
  }

  isAlive(): boolean {
    return this.child !== null && this.initialized && !this.stopping;
  }

  // JSON-RPC 2.0 요청 전송 (id 포함, 응답 대기)
  async request<T = unknown>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    if (!this.child?.stdin?.writable && method !== 'initialize') {
      throw new Error('App server process is not running');
    }

    const id = this.nextRequestId++;
    const message = JSON.stringify({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
      id,
    });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`JSON-RPC request timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.child!.stdin!.write(message + '\n');
    });
  }

  // JSON-RPC 2.0 알림 전송 (id 없음, 응답 불필요)
  sendNotification(method: string, params?: unknown): void {
    if (!this.child?.stdin?.writable) return;
    const message = JSON.stringify({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    });
    this.child.stdin.write(message + '\n');
  }

  // 서버→클라이언트 알림 핸들러 등록
  // 반환값: 핸들러 해제 함수
  onNotification(method: string, handler: (params: unknown) => void): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers!.delete(handler);
    };
  }

  // stdout JSONL 라인 파싱 및 디스패치
  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // 기동 로그 등 비-JSON 출력은 무시
      return;
    }

    // 요청에 대한 응답 (id 포함)
    if ('id' in msg && typeof msg.id === 'number') {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        if ('error' in msg && msg.error) {
          const err = msg.error as { code?: number; message?: string };
          pending.reject(new Error(`JSON-RPC error ${err.code ?? -1}: ${err.message ?? 'unknown'}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // 서버→클라이언트 알림 (id 없음, method 있음)
    if ('method' in msg && typeof msg.method === 'string') {
      const handlers = this.notificationHandlers.get(msg.method);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(msg.params);
          } catch (err) {
            console.error(`[codex-appserver] notification handler error (${msg.method}):`, err);
          }
        }
      }
    }
  }

  // 프로세스 종료 처리 + 지수 백오프 자동 재시작
  private handleExit(code: number | null, signal: string | null): void {
    const wasAlive = this.initialized;
    this.child = null;
    this.initialized = false;

    // 대기 중인 요청 전부 거부
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`App server exited (code=${code}, signal=${signal})`));
    }
    this.pendingRequests.clear();

    if (this.stopping) return;

    if (wasAlive) {
      console.warn(`[codex-appserver] process exited unexpectedly (code=${code}, signal=${signal})`);
    }

    // 지수 백오프로 자동 재시작
    if (this.autoRestart && this.restartCount < this.maxRestartCount) {
      const delay = Math.min(
        DEFAULT_RESTART_DELAY_MS * Math.pow(2, this.restartCount),
        MAX_RESTART_DELAY_MS,
      );
      this.restartCount++;
      console.log(
        `[codex-appserver] restarting in ${delay}ms (attempt ${this.restartCount}/${this.maxRestartCount})`,
      );
      setTimeout(() => {
        if (!this.stopping) {
          this.start().catch((err) => {
            console.error('[codex-appserver] restart failed:', err.message);
          });
        }
      }, delay);
    } else if (this.restartCount >= this.maxRestartCount) {
      console.error(
        `[codex-appserver] max restart count (${this.maxRestartCount}) reached, giving up`,
      );
    }
  }

  // 재시작 카운터 초기화 (정상 요청 완료 후 호출하여 안정 상태 표시)
  resetRestartCount(): void {
    this.restartCount = 0;
  }
}
