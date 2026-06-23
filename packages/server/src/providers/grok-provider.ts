import type { ExecuteOptions, ExecuteResult, ProviderConfigYaml, ProviderEvent, TokenUsage } from '@star-cliproxy/shared';
import { BaseProvider, gracefulKill, trackProcess } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import { spawn } from 'node:child_process';

// macOS ARG_MAX = 1MB. 여유 두어 800KB 한도 (agy-provider와 동일 기준).
// grok 0.2.x는 헤드리스 입력으로 -p <arg>를 사용하므로 프롬프트가 인수 한도에 묶임.
const MAX_PROMPT_ARG_BYTES = 800_000;

// 8-bit ANSI escape sequences 제거 (terminal color, cursor codes 등).
// grok은 stdout이 TTY가 아니면 plain text를 내보내지만 방어적으로 스트립.
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function estimateTokens(text: string): TokenUsage {
  const completionTokens = Math.ceil(text.length / 4);
  return { promptTokens: 0, completionTokens, totalTokens: completionTokens };
}

/**
 * xAI Grok Build CLI (`grok`, "Grok Build TUI") provider — 2026-05-20 발표, v0.2.x 기준.
 *
 * 동작:
 *  - 헤드리스 단발 실행: `grok -m <model> -p <prompt>` → stdout에 응답 plain text 출력 후 종료.
 *  - -m/--model 지원 → 매핑된 actual_model을 실제로 전달 (agy와의 핵심 차이).
 *    `grok models`(0.2.60): `grok-build`(default, reasoning) + `grok-composer-2.5-fast`.
 *  - --effort 지원(0.2.x) → low/medium/high/xhigh/max가 cliproxy ReasoningEffort와 정확히
 *    일치해 **리맵 없이 그대로 전달**(copilot/codex와의 차이). 매핑별 reasoning_effort opt-in.
 *    [gotcha] effort는 모델별 — `grok-composer-2.5-fast`는 effort 미지원(API 400)이라
 *    composer 매핑에는 reasoning_effort를 설정하지 말 것. reasoning 모델(grok-build)만 지원.
 *  - --output-format은 streaming-json도 지원하나, 안정성·단순성을 위해 plain 단발 후
 *    executeStream에서 단일 text_delta + done으로 가짜 스트리밍 wrap (agy와 동일 전략).
 *  - 세션 연속성은 매 호출 신규 (-c/--continue, -r/--resume은 사용자가 extra_args로만 옵트인).
 *  - --always-approve 등 권한 우회 플래그는 보안 영향이 커서 기본 미포함, extra_args로 옵트인.
 */
export class GrokProvider extends BaseProvider {
  readonly name = 'grok' as const;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();
  }

  // grok CLI는 `-m <model> -p <prompt>` 형태로 단발 실행. messages는 단일 텍스트로 직렬화.
  protected buildArgs(options: ExecuteOptions): string[] {
    const model = options.model || this.config.default_model;
    const prompt = convertMessagesToSinglePrompt(options.messages);

    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_ARG_BYTES) {
      throw new Error(
        `grok: prompt exceeds ${MAX_PROMPT_ARG_BYTES} bytes ` +
        `(actual ${Buffer.byteLength(prompt, 'utf8')}). grok 헤드리스 모드는 -p 인수로 프롬프트를 받아 ` +
        `macOS ARG_MAX 1MB 한도에 묶입니다. 메시지를 줄이거나 요약 후 재시도하세요.`
      );
    }

    // 추론 수준 주입 (--effort). grok은 low/medium/high/xhigh/max를 모두 지원하므로
    // ReasoningEffort 값을 리맵 없이 그대로 전달한다. 사용자가 extra_args에 --effort 또는
    // --reasoning-effort를 이미 넣었으면 건너뛴다.
    const userHasEffort = this.config.extra_args.some(
      (arg) => arg === '--effort' || arg === '--reasoning-effort',
    );
    const effortArgs = options.reasoningEffort && !userHasEffort
      ? ['--effort', options.reasoningEffort]
      : [];

    // 사용자 extra_args를 모델/프롬프트 플래그 앞에 배치해 print-mode 옵션이 이 실행에 적용되게 함.
    // -p <prompt>는 마지막에 두어 프롬프트가 마지막 인수가 되도록 보장.
    const modelArgs = model ? ['-m', model] : [];
    return [...this.config.extra_args, ...effortArgs, ...modelArgs, '-p', prompt];
  }

  // grok은 plain text를 stdout으로 흘리므로 BaseProvider의 NDJSON 라인 파싱을 우회.
  // stdout 전체를 단일 응답 텍스트로 처리.
  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const args = this.buildArgs({ ...options, stream: false });
    const { stdout, stderr, exitCode } = await this.runOnce(args, options.signal);

    if (exitCode !== 0) {
      options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout, stderr });
      throw new Error(`grok CLI exited with code ${exitCode}: ${stderr.trim() || stdout.trim()}`);
    }

    options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout, stderr });

    const content = stripAnsi(stdout).trim();
    return {
      content,
      usage: estimateTokens(content),
      finishReason: 'stop',
    };
  }

  // 실시간 스트리밍 출력을 쓰지 않음(plain 단발). 전체 응답을 받은 뒤 단일 chunk로 wrap.
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
      // ExecuteResult(OpenAI 'tool_calls') → ProviderDoneEvent('tool_use') 매핑. CLI는 실제로 미발생.
      finishReason: result.finishReason === 'tool_calls' ? 'tool_use' : (result.finishReason ?? 'stop'),
    };
  }

  // BaseProvider.runProcess는 private이라 재사용 불가 → 동일 패턴 인라인 구현 (agy-provider와 동일).
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
        reject(new Error(`grok CLI timed out after ${this.config.timeout_ms}ms`));
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
        reject(new Error(`Failed to spawn grok CLI: ${err.message}`));
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
