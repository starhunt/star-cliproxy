import type { ChatResponseFormat, ExecuteOptions, ExecuteResult, ProviderConfigYaml, ProviderEvent, TokenUsage } from '@star-cliproxy/shared';
import { BaseProvider, gracefulKill, trackProcess } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// macOS ARG_MAX = 1MB. 여유 두어 800KB 한도 (gemini-provider와 동일 기준).
// agy 1.1.7은 stdin으로 프롬프트 입력을 지원하지 않아 -p <arg>만 사용.
const MAX_PROMPT_ARG_BYTES = 800_000;

// 8-bit ANSI escape sequences 제거 (terminal color, cursor codes 등).
// 일부 환경에서 응답 문자열에 색상 코드가 섞일 수 있어 방어적으로 제거한다.
// 참고: 진짜 stdout이 TTY가 아니면 색상은 자동 비활성화되지만 방어적으로 스트립.
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function estimateTokens(text: string): TokenUsage {
  const completionTokens = Math.ceil(text.length / 4);
  return { promptTokens: 0, completionTokens, totalTokens: completionTokens };
}

interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

interface AgyResultPayload {
  status?: string;
  response?: string;
  // --json-schema로 요청했을 때만 채워지는 스키마 준수 값.
  // response는 프로즈와 스키마 외 필드가 섞여 유효한 JSON이 아닐 수 있어 이쪽이 정본이다.
  structured_output?: unknown;
  json_schema?: unknown;
  error?: string;
  usage?: AgyUsage;
}

// 이 요청이 agy에 스키마 강제를 요구하는지. json_object/text는 agy가 강제하지 못하므로 제외.
function wantsSchemaEnforcement(format: ChatResponseFormat | undefined): format is Extract<ChatResponseFormat, { type: 'json_schema' }> {
  return format?.type === 'json_schema';
}

// structured_output을 OpenAI message.content로 쓸 JSON 문자열로 직렬화한다.
// 값이 없으면 오염된 response로 폴백하지 않고 실패시킨다 — 클라이언트가
// 유효하지 않은 JSON을 스키마 준수 응답으로 오인하는 편보다 폴백 라우팅이 낫다.
function requireStructuredOutput(result: AgyResultPayload): string {
  if (result.structured_output === undefined || result.structured_output === null) {
    throw new Error(
      'agy CLI가 structured_output을 반환하지 않았습니다 (response_format=json_schema). ' +
      'agy 1.1.12+ 의 --json-schema 지원이 필요합니다.',
    );
  }
  return typeof result.structured_output === 'string'
    ? result.structured_output
    : JSON.stringify(result.structured_output);
}

function toTokenUsage(usage: AgyUsage | undefined, fallbackText = ''): TokenUsage {
  if (!usage) return estimateTokens(fallbackText);

  const promptTokens = (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0);
  const completionTokens = (usage.output_tokens ?? 0) + (usage.thinking_tokens ?? 0);
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? (promptTokens + completionTokens),
  };
}

function parseLastJsonLine(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some versions can print a diagnostic line before the final JSON object.
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Keep scanning: future CLI versions may emit informational lines before the result.
    }
  }
  throw new Error('agy CLI returned no valid JSON result');
}

function hasFlag(args: string[], flags: string[]): boolean {
  return args.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}

function withoutValueFlag(args: string[], flags: string[]): string[] {
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (flags.some((flag) => arg.startsWith(`${flag}=`))) continue;
    if (flags.includes(arg)) {
      i += 1;
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function normalizeEffort(effort: ExecuteOptions['reasoningEffort']): 'low' | 'medium' | 'high' | undefined {
  if (!effort) return undefined;
  // agy 1.1.5+ exposes low|medium|high. Preserve the shared API's stronger
  // presets by mapping them to the strongest level this provider supports.
  return effort === 'xhigh' || effort === 'max' ? 'high' : effort;
}

function stripEffortVariant(model: string): string {
  return model
    // Gemini의 effort variant만 base slug로 바꾼다. gpt-oss-120b-medium처럼
    // suffix가 모델 ID 자체인 다른 계열은 훼손하면 안 된다.
    .replace(/^(gemini-(?:3\.[56]-flash|3\.1-pro))-(low|medium|high)$/i, '$1')
    .replace(/\s+\((Low|Medium|High)\)$/i, '');
}

// agy 백엔드가 모델 선택을 위임받는 표시용 placeholder. 이 값일 때는 --model을 보내지 않아
// agy가 자동 선택하도록 둔다(기존 동작 보존).
const MODEL_PLACEHOLDER = 'antigravity';

/**
 * Google Antigravity CLI (agy) provider — 1.1.7 기준.
 *
 * 1.1.7 사양:
 *  - `agy models`가 안정적인 effort variant slug를 출력하며, --model로 pin할 수 있다.
 *  - --effort low|medium|high 지원. CLI가 받는 model family slug + effort 조합으로 정규화해
 *    variant suffix와 별도 effort를 함께 넘길 때 생기는 충돌을 방지한다.
 *  - --output-format json|stream-json 지원. stream-json의 agent_response delta를 실제 스트리밍하고
 *    result usage(input/output/thinking/cache)를 OpenAI usage로 변환한다.
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
  protected buildArgs(
    options: ExecuteOptions,
    outputFormat: 'json' | 'stream-json' = 'json',
  ): string[] {
    const prompt = convertMessagesToSinglePrompt(options.messages);

    // 스키마도 -p와 같은 인수 공간을 쓰므로 프롬프트와 합산해 ARG_MAX를 지킨다.
    const schemaArg = wantsSchemaEnforcement(options.chatResponseFormat)
      ? JSON.stringify(options.chatResponseFormat.json_schema.schema)
      : undefined;
    const argBytes = Buffer.byteLength(prompt, 'utf8')
      + (schemaArg ? Buffer.byteLength(schemaArg, 'utf8') : 0);

    if (argBytes > MAX_PROMPT_ARG_BYTES) {
      throw new Error(
        `agy: prompt exceeds ${MAX_PROMPT_ARG_BYTES} bytes ` +
        `(actual ${argBytes}${schemaArg ? ', response_format schema 포함' : ''}). agy는 prompt를 -p 인수로 받아 ` +
        `-p 인수 한도(macOS ARG_MAX 1MB)에 묶임. 메시지를 줄이거나 요약 후 재시도하세요.`
      );
    }

    // agy parses print-mode flags before the print prompt. Keep all flags
    // (extra_args + --model) before -p so options such as --print-timeout and
    // --model apply to this run instead of being interpreted as prompt text or
    // ignored after the prompt.
    // 출력 형식은 파서 계약이므로 사용자의 오래된 extra_args보다 provider가 강제한 값을 우선한다.
    const extraArgs = withoutValueFlag(this.config.extra_args, ['--output-format']);
    const args = [...extraArgs, '--output-format', outputFormat];

    // 매핑된 actual_model을 --model로 전달. placeholder면 생략해 agy 자동 선택.
    // 사용자가 extra_args에 --model을 직접 넣었다면 그 값을 존중하고 중복 추가하지 않는다.
    const requestedEffort = normalizeEffort(options.reasoningEffort);
    const model = requestedEffort
      ? stripEffortVariant(options.model?.trim() ?? '')
      : options.model?.trim();
    const userSetModel = hasFlag(this.config.extra_args, ['--model']);
    if (model && model !== MODEL_PLACEHOLDER && !userSetModel) {
      args.push('--model', model);
    }

    const userSetEffort = hasFlag(this.config.extra_args, ['--effort']);
    if (requestedEffort && !userSetEffort) {
      args.push('--effort', requestedEffort);
    }

    // OpenAI response_format.json_schema → agy --json-schema.
    // OpenAI 래퍼(name/strict)가 아니라 중첩 schema만 전달해야 agy가 그대로 강제한다.
    // 사용자가 extra_args로 스키마를 고정했다면 --model/--effort와 같은 정책으로 그 값을 존중한다.
    const userSetSchema = hasFlag(this.config.extra_args, ['--json-schema']);
    if (schemaArg && !userSetSchema) {
      args.push('--json-schema', schemaArg);
    }

    args.push('-p', prompt);
    return args;
  }

  // agy는 --json-schema로 스키마만 강제할 수 있다. json_object/text는 강제 수단이 없어
  // 미지원으로 선언하고 라우트가 X-Unsupported-Params로 알리게 한다.
  override supportsResponseFormat(format: ChatResponseFormat): boolean {
    return format.type === 'json_schema';
  }

  // json 결과를 사용해 오류와 실제 token usage를 보존한다.
  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const args = this.buildArgs({ ...options, stream: false }, 'json');
    const { stdout, stderr, exitCode } = await this.runOnce(args, options.signal);

    if (exitCode !== 0) {
      options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout, stderr });
      throw new Error(`agy CLI exited with code ${exitCode}: ${stderr.trim() || stdout.trim()}`);
    }

    options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout, stderr });

    const envelope = parseLastJsonLine(stdout) as { result?: AgyResultPayload } & AgyResultPayload;
    const result = envelope.result ?? envelope;
    if (result.status !== 'SUCCESS') {
      throw new Error(`agy CLI failed: ${result.error || 'unknown error'}`);
    }

    // 스키마를 요청했으면 response(프로즈 + 스키마 외 필드 혼재)가 아니라
    // structured_output을 그대로 message.content로 돌려준다.
    const content = wantsSchemaEnforcement(options.chatResponseFormat)
      ? requireStructuredOutput(result)
      : stripAnsi(result.response ?? '').trim();
    return {
      content,
      usage: toTokenUsage(result.usage, content),
      finishReason: 'stop',
    };
  }

  // stream-json의 agent_response delta를 OpenAI 호환 ProviderEvent로 변환한다.
  override async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    const args = this.buildArgs({ ...options, stream: true }, 'stream-json');
    const child = spawn(this.config.cli_path, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: this.getCleanEnv(),
      cwd: this.workingDir,
      shell: process.platform === 'win32',
    });
    trackProcess(child);

    const debugLines: string[] = [];
    const stderrChunks: Buffer[] = [];
    let terminalError: Error | undefined;
    let finalResult: AgyResultPayload | undefined;
    let emittedText = false;
    // agy --help: stream-json에서 스키마는 "final result에만" 적용된다.
    // 실측으로도 delta는 프로즈를 먼저 흘린 뒤 마지막 turn에서 스키마 외 필드가 섞인 JSON을 뱉으므로,
    // 스키마 요청 시에는 delta를 내보내지 않고 최종 structured_output 하나만 emit한다.
    const schemaEnforced = wantsSchemaEnforcement(options.chatResponseFormat);

    child.stderr?.on('data', (data: Buffer) => stderrChunks.push(data));
    const closePromise = new Promise<number>((resolve) => {
      child.on('error', (err) => {
        terminalError = new Error(`Failed to spawn agy CLI: ${err.message}`);
        resolve(1);
      });
      child.on('close', (code) => resolve(code ?? 1));
    });

    const timeout = setTimeout(() => {
      terminalError = new Error(`agy CLI timed out after ${this.config.timeout_ms}ms`);
      gracefulKill(child);
    }, this.config.timeout_ms);

    const onAbort = () => {
      terminalError = new Error('Request cancelled');
      gracefulKill(child);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const rl = createInterface({ input: child.stdout! });
      for await (const line of rl) {
        if (options.onDebug) debugLines.push(line);

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (data.event === 'step_update') {
          const step = data.step_update as Record<string, unknown> | undefined;
          if (!schemaEnforced && step?.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
            emittedText = true;
            yield { type: 'text_delta', text: step.text_delta };
          }
          continue;
        }

        if (data.event === 'result') {
          const result = data.result as AgyResultPayload | undefined;
          if (result?.status !== 'SUCCESS') {
            throw new Error(`agy CLI failed: ${result?.error || 'unknown error'}`);
          }
          finalResult = result;
        }
      }

      const exitCode = await closePromise;
      if (terminalError) throw terminalError;
      if (exitCode !== 0) {
        throw new Error(`agy CLI exited with code ${exitCode}: ${Buffer.concat(stderrChunks).toString('utf-8').trim()}`);
      }
      if (!finalResult) throw new Error('agy CLI stream ended without a result event');

      if (schemaEnforced) {
        // 스키마 준수 JSON 하나만 내보낸다 (delta는 위에서 억제됨).
        yield { type: 'text_delta', text: requireStructuredOutput(finalResult) };
      } else {
        // Delta를 내보내지 않은 호환 구현에서도 최종 response를 잃지 않는다.
        const fallbackContent = stripAnsi(finalResult.response ?? '').trim();
        if (!emittedText && fallbackContent) {
          yield { type: 'text_delta', text: fallbackContent };
        }
      }

      // 프로세스가 정상 종료된 뒤 완료 이벤트를 내보내야 소비자가 done에서 순회를
      // 중단하더라도 CLI를 강제 종료하거나 임시 리소스를 조기에 정리하지 않는다.
      yield {
        type: 'usage',
        usage: toTokenUsage(finalResult.usage, finalResult.response ?? ''),
      };
      yield { type: 'done', finishReason: 'stop' };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null) gracefulKill(child);
      if (options.onDebug) {
        options.onDebug({
          cliArgs: [this.config.cli_path, ...args],
          stderr: Buffer.concat(stderrChunks).toString('utf-8'),
          streamLines: debugLines,
        });
      }
    }
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
