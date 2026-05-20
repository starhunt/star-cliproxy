import type { ExecuteOptions, ExecuteResult, ProviderConfigYaml, ProviderEvent, TokenUsage } from '@star-cliproxy/shared';
import { BaseProvider, gracefulKill, trackProcess } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import { spawn } from 'node:child_process';

// macOS ARG_MAX = 1MB. 여유 두어 800KB 한도 (gemini-provider와 동일 기준).
// agy 1.0.0은 stdin으로 프롬프트 입력을 지원하지 않아 -p <arg>만 사용.
const MAX_PROMPT_ARG_BYTES = 800_000;

// 8-bit ANSI escape sequences 제거 (terminal color, cursor codes 등).
// agy 1.0.0은 plain text를 그대로 stdout으로 내보내지만 일부 환경에서 색상 코드가 섞일 수 있음.
// 참고: 진짜 stdout이 TTY가 아니면 색상은 자동 비활성화되지만 방어적으로 스트립.
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function estimateTokens(text: string): TokenUsage {
  const completionTokens = Math.ceil(text.length / 4);
  return { promptTokens: 0, completionTokens, totalTokens: completionTokens };
}

/**
 * Google Antigravity CLI (agy) provider — 2026-05-19 IO 2026 발표 1.0.0 기준.
 *
 * 1.0.0 제약:
 *  - -m/--model 플래그 미지원 → 매핑된 actual_model은 응답 메타데이터 표시용으로만 사용,
 *    agy는 자체 백엔드 정책으로 모델 선택.
 *  - --json/--stream-json 플래그 미지원 → 출력은 plain text. NDJSON 파싱 안 함.
 *  - 명시적 스트리밍 API 없음 → executeStream은 단일 text_delta + done으로 가짜 스트리밍 wrap.
 *  - 세션 연속성은 매 호출 신규 (--continue/--conversation은 사용자가 extra_args로만 옵트인).
 *  - --dangerously-skip-permissions는 보안 영향이 커서 기본 미포함, 사용자가 extra_args로 옵트인.
 */
export class AgyProvider extends BaseProvider {
  readonly name = 'agy' as const;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();
  }

  // agy CLI는 인수 한 줄로 prompt를 받음. messages는 단일 텍스트로 직렬화.
  protected buildArgs(options: ExecuteOptions): string[] {
    const prompt = convertMessagesToSinglePrompt(options.messages);

    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_ARG_BYTES) {
      throw new Error(
        `agy: prompt exceeds ${MAX_PROMPT_ARG_BYTES} bytes ` +
        `(actual ${Buffer.byteLength(prompt, 'utf8')}). agy 1.0.0은 stdin 프롬프트를 지원하지 않아 ` +
        `-p 인수 한도(macOS ARG_MAX 1MB)에 묶임. 메시지를 줄이거나 요약 후 재시도하세요.`
      );
    }

    const args: string[] = ['-p', prompt];
    args.push(...this.config.extra_args);
    return args;
  }

  // agy는 plain text를 stdout으로 흘리므로 BaseProvider의 NDJSON 라인 파싱을 우회.
  // stdout 전체를 단일 응답 텍스트로 처리.
  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const args = this.buildArgs({ ...options, stream: false });
    const { stdout, stderr, exitCode } = await this.runOnce(args, options.signal);

    if (exitCode !== 0) {
      options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout, stderr });
      throw new Error(`agy CLI exited with code ${exitCode}: ${stderr.trim() || stdout.trim()}`);
    }

    options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout, stderr });

    const content = stripAnsi(stdout).trim();
    return {
      content,
      usage: estimateTokens(content),
      finishReason: 'stop',
    };
  }

  // 1.0.0은 실시간 스트리밍 출력이 없음. 전체 응답을 받은 뒤 단일 chunk로 wrap.
  // chat completion 스트리밍 호환을 유지하기 위함 (클라이언트 코드 변경 없이 동작).
  override async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    const result = await this.execute({ ...options, stream: false });

    if (result.content) {
      yield { type: 'text_delta', text: result.content };
    }
    yield {
      type: 'usage',
      usage: result.usage,
    };
    yield {
      type: 'done',
      finishReason: result.finishReason ?? 'stop',
    };
  }

  // BaseProvider.runProcess는 private이라 재사용 불가 → 동일 패턴 인라인 구현.
  // executeStream을 자체적으로 wrap하므로 streaming용 spawnProcess는 사용하지 않음.
  private runOnce(
    args: string[],
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const isWin = process.platform === 'win32';
      const child = spawn(this.config.cli_path, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.getCleanEnv(),
        cwd: this.workingDir,
        shell: isWin,
      });
      trackProcess(child);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const timeout = setTimeout(() => {
        gracefulKill(child);
        reject(new Error(`agy CLI timed out after ${this.config.timeout_ms}ms`));
      }, this.config.timeout_ms);

      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timeout);
          gracefulKill(child);
          reject(new Error('Request cancelled'));
        }, { once: true });
      }

      child.stdout?.on('data', (data: Buffer) => stdoutChunks.push(data));
      child.stderr?.on('data', (data: Buffer) => stderrChunks.push(data));

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn agy CLI: ${err.message}`));
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
}
