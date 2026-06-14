import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 내장 Channel bridge 프로세스의 라이프사이클 관리자 (서버 전역 단일 인스턴스).
// 대시보드 Claude 설정 화면에서 start/stop/restart/status로 제어한다.

export interface BridgeLaunchOptions {
  port: number;
  host?: string;
  apiKey?: string;
  cliPath: string;
  defaultModel: string;
  workingDir?: string;
  timeoutMs: number;
  extraArgs?: string[];
  maxConcurrent?: number;
  command?: string;          // 커스텀 실행 커맨드(shell). 비우면 내장 bridge 사용
  readyTimeoutMs?: number;   // health ready 대기 타임아웃 (기본 15초)
}

export interface BridgeStatus {
  running: boolean;
  managed: boolean;
  pid?: number;
  port?: number;
  host?: string;
  uptimeMs?: number;
  healthy?: boolean;
  lastError?: string;
  command?: string;
}

async function pingHealth(host: string, port: number, apiKey?: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://${host}:${port}/health`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ChannelBridgeManager {
  private child: ChildProcess | null = null;
  private startedAt = 0;
  private currentPort?: number;
  private currentHost = '127.0.0.1';
  private apiKey?: string;
  private lastError?: string;
  private launchCommand?: string;

  isRunning(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  async start(opts: BridgeLaunchOptions): Promise<BridgeStatus> {
    if (this.isRunning()) return this.status();

    const host = opts.host || '127.0.0.1';
    const port = opts.port;
    const readyTimeout = opts.readyTimeoutMs ?? 15_000;

    const { cmd, args, useShell, label } = this.resolveCommand(opts);
    this.launchCommand = label;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_HOST: host,
      BRIDGE_CLI_PATH: opts.cliPath,
      BRIDGE_DEFAULT_MODEL: opts.defaultModel,
      BRIDGE_TIMEOUT_MS: String(opts.timeoutMs),
      BRIDGE_EXTRA_ARGS: JSON.stringify(opts.extraArgs ?? []),
      BRIDGE_MAX_CONCURRENT: String(opts.maxConcurrent ?? 4),
    };
    if (opts.apiKey) env.BRIDGE_API_KEY = opts.apiKey;
    if (opts.workingDir) env.BRIDGE_WORKING_DIR = opts.workingDir;

    this.lastError = undefined;
    const child = spawn(cmd, args, {
      env,
      shell: useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    this.child = child;
    this.currentPort = port;
    this.currentHost = host;
    this.apiKey = opts.apiKey;
    this.startedAt = Date.now();

    child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[channel-bridge] ${d}`));
    child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString();
      this.lastError = text.trim().slice(0, 500);
      process.stderr.write(`[channel-bridge] ${text}`);
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (code && code !== 0) this.lastError = `bridge exited with code ${code}`;
      else if (signal) this.lastError = `bridge terminated by ${signal}`;
    });
    child.on('error', (err) => {
      this.lastError = err.message;
      if (this.child === child) this.child = null;
    });

    // health ready 대기
    const deadline = Date.now() + readyTimeout;
    while (Date.now() < deadline) {
      if (!this.isRunning()) {
        throw new Error(`Channel bridge failed to start: ${this.lastError ?? 'process exited early'}`);
      }
      if (await pingHealth(host, port, opts.apiKey)) {
        return this.status();
      }
      await sleep(300);
    }

    await this.stop();
    throw new Error(`Channel bridge did not become healthy within ${readyTimeout}ms on ${host}:${port}`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, 5000);
      killTimer.unref?.();
      child.once('exit', () => { clearTimeout(killTimer); resolve(); });
      try { child.kill('SIGTERM'); } catch { clearTimeout(killTimer); resolve(); }
    });
    this.child = null;
  }

  async restart(opts: BridgeLaunchOptions): Promise<BridgeStatus> {
    await this.stop();
    return this.start(opts);
  }

  async status(): Promise<BridgeStatus> {
    const running = this.isRunning();
    let healthy = false;
    if (running && this.currentPort) {
      healthy = await pingHealth(this.currentHost, this.currentPort, this.apiKey);
    }
    return {
      running,
      managed: true,
      pid: running ? this.child?.pid : undefined,
      port: this.currentPort,
      host: this.currentHost,
      uptimeMs: running ? Date.now() - this.startedAt : undefined,
      healthy,
      lastError: this.lastError,
      command: this.launchCommand,
    };
  }

  // 커스텀 커맨드 또는 내장 start 진입점을 현재 런타임(tsx/node)에 맞춰 해석
  private resolveCommand(opts: BridgeLaunchOptions): { cmd: string; args: string[]; useShell: boolean; label: string } {
    if (opts.command && opts.command.trim()) {
      return { cmd: opts.command, args: [], useShell: true, label: opts.command };
    }
    const here = fileURLToPath(import.meta.url);
    const isTs = here.endsWith('.ts');
    const entry = join(dirname(here), isTs ? 'start.ts' : 'start.js');
    if (isTs) {
      // dev 런타임(tsx) — node에 tsx ESM loader를 등록해 .ts 진입점 실행
      return { cmd: process.execPath, args: ['--import', 'tsx', entry], useShell: false, label: `node --import tsx ${entry}` };
    }
    return { cmd: process.execPath, args: [entry], useShell: false, label: `node ${entry}` };
  }
}

// 서버 전역 단일 매니저
export const channelBridgeManager = new ChannelBridgeManager();
