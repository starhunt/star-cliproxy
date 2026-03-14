import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  ExecuteOptions,
  ExecuteResult,
  StreamChunk,
  HealthStatus,
  ProviderName,
  ProviderConfigYaml,
} from '@star-cliproxy/shared';
import { getParserForProvider, type StreamParser } from '../utils/stream-transformer.js';

export abstract class BaseProvider {
  abstract readonly name: ProviderName;

  protected config: ProviderConfigYaml;
  protected parser: StreamParser;

  constructor(config: ProviderConfigYaml) {
    this.config = config;
    // parser는 서브클래스에서 name 초기화 후 설정
    this.parser = null!;
  }

  protected initParser() {
    this.parser = getParserForProvider(this.name);
  }

  // CLI 인수 구성 (서브클래스에서 구현)
  protected abstract buildArgs(options: ExecuteOptions): string[];

  // non-streaming 실행
  async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const args = this.buildArgs({ ...options, stream: false });
    const { stdout, stderr, exitCode } = await this.runProcess(args, options.signal);

    if (exitCode !== 0) {
      throw new Error(`${this.name} CLI exited with code ${exitCode}: ${stderr}`);
    }

    return this.parseNonStreamOutput(stdout);
  }

  // streaming 실행
  async *executeStream(options: ExecuteOptions): AsyncIterable<StreamChunk> {
    const args = this.buildArgs({ ...options, stream: true });
    const child = this.spawnProcess(args);
    child.stdin?.end();

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        child.kill('SIGTERM');
      }, { once: true });
    }

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, this.config.timeout_ms);

    try {
      const rl = createInterface({ input: child.stdout! });

      for await (const line of rl) {
        const chunk = this.parser.parse(line);
        if (chunk) {
          yield chunk;
          if (chunk.type === 'done') break;
        }
      }
    } finally {
      clearTimeout(timeout);
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    }
  }

  // 건강 체크 (--version 실행)
  async checkHealth(): Promise<HealthStatus> {
    try {
      const { exitCode } = await this.runProcess(['--version'], undefined, 10_000);
      return exitCode === 0 ? 'healthy' : 'unhealthy';
    } catch {
      return 'unhealthy';
    }
  }

  protected spawnProcess(args: string[]): ChildProcess {
    // 부모 프로세스(Claude Code)의 환경변수를 정리하여 중첩 감지 방지
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
    delete cleanEnv.CLAUDE_CODE_SESSION_ACCESS_TOKEN;
    delete cleanEnv.CLAUDE_CODE_SSE_PORT;
    delete cleanEnv.CLAUDE_CODE_ENABLE_TASKS;
    delete cleanEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS;

    return spawn(this.config.cli_path, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv,
      cwd: '/tmp',
    });
  }

  private async runProcess(
    args: string[],
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(args);
      // stdin을 즉시 닫아 CLI가 입력 대기하지 않도록
      child.stdin?.end();
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`${this.name} CLI timed out after ${timeoutMs ?? this.config.timeout_ms}ms`));
      }, timeoutMs ?? this.config.timeout_ms);

      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timeout);
          child.kill('SIGTERM');
          reject(new Error('Request cancelled'));
        }, { once: true });
      }

      child.stdout?.on('data', (data: Buffer) => stdoutChunks.push(data));
      child.stderr?.on('data', (data: Buffer) => stderrChunks.push(data));

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn ${this.name} CLI: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: Buffer.concat(stderrChunks).toString('utf-8'),
          exitCode: code ?? 1,
        });
      });
    });
  }

  // non-streaming 출력에서 텍스트 추출 (서브클래스에서 오버라이드 가능)
  protected parseNonStreamOutput(stdout: string): ExecuteResult {
    // 기본: NDJSON 라인들에서 텍스트 추출
    const lines = stdout.trim().split('\n');
    const contentParts: string[] = [];
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for (const line of lines) {
      const chunk = this.parser.parse(line);
      if (chunk?.type === 'delta' && chunk.content) {
        contentParts.push(chunk.content);
      }
      if (chunk?.type === 'done' && chunk.usage) {
        usage = chunk.usage;
      }
    }

    const content = contentParts.join('');

    // 토큰 정보 없으면 추정
    if (usage.totalTokens === 0) {
      usage = estimateTokens(content);
    }

    return {
      content,
      usage,
      finishReason: 'stop',
    };
  }
}

// 간이 토큰 추정 (문자수 / 4)
function estimateTokens(text: string): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  const completionTokens = Math.ceil(text.length / 4);
  return {
    promptTokens: 0,
    completionTokens,
    totalTokens: completionTokens,
  };
}
