import type { ChatResponseFormat, ExecuteOptions, ExecuteResult, ProviderConfigYaml, ProviderEvent, TokenUsage } from '@star-cliproxy/shared';
import { BaseProvider, gracefulKill, trackProcess } from './base-provider.js';
import { requireStructuredOutput, schemaArgument, shouldBufferStream, wantsSchemaEnforcement } from './structured-output.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// macOS ARG_MAX = 1MB. 여유 두어 800KB 한도 (agy-provider와 동일 기준).
// 짧은 프롬프트는 -p <arg>, 큰 프롬프트는 --prompt-file을 사용한다.
const MAX_PROMPT_ARG_BYTES = 800_000;

// 8-bit ANSI escape sequences 제거 (terminal color, cursor codes 등).
// JSON 응답 문자열에 ANSI 코드가 섞인 경우를 방어적으로 처리한다.
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function estimateTokens(text: string): TokenUsage {
  const completionTokens = Math.ceil(text.length / 4);
  return { promptTokens: 0, completionTokens, totalTokens: completionTokens };
}

interface GrokUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
}

interface GrokJsonResult {
  type?: string;
  data?: string;
  text?: string;
  // --json-schema로 요청했을 때만 채워지는 스키마 준수 값. 버전에 따라 표기가 갈려 둘 다 읽는다.
  structuredOutput?: unknown;
  structured_output?: unknown;
  error?: string;
  message?: string;
  stopReason?: string;
  usage?: GrokUsage;
}

// grok 버전에 따라 camelCase/snake_case가 갈리므로 둘 다 확인한다.
function grokStructuredOutput(result: GrokJsonResult): unknown {
  return result.structuredOutput ?? result.structured_output;
}

interface PreparedInvocation {
  args: string[];
  cleanup?: () => Promise<void>;
}

function toTokenUsage(usage: GrokUsage | undefined, fallbackText = ''): TokenUsage {
  if (!usage) return estimateTokens(fallbackText);

  const promptTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const completionTokens = usage.output_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? (promptTokens + completionTokens),
  };
}

function parseLastJsonLine(stdout: string): GrokJsonResult {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as GrokJsonResult;
  } catch {
    // Some versions can print a diagnostic line before the final JSON object.
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]) as GrokJsonResult;
    } catch {
      // Update notices and diagnostics can precede the JSON result.
    }
  }
  throw new Error('grok CLI returned no valid JSON result');
}

function toFinishReason(stopReason: string | undefined): 'stop' | 'length' {
  return stopReason && /max.?tokens?/i.test(stopReason) ? 'length' : 'stop';
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
  // grok-4.5 currently advertises low|medium|high. Map the shared API's
  // stronger presets to high instead of forwarding values the CLI rejects.
  return effort === 'xhigh' || effort === 'max' ? 'high' : effort;
}

/**
 * xAI Grok Build CLI (`grok`, "Grok Build TUI") provider — v0.2.112 기준.
 *
 * 동작:
 *  - 헤드리스 단발 실행: `grok -m <model> -p <prompt> --output-format json`.
 *  - -m/--model 지원 → 매핑된 actual_model을 실제로 전달 (agy와의 핵심 차이).
 *    `grok models`(0.2.112, 기본 카탈로그): `grok-4.5`.
 *  - grok-4.5 --effort는 low|medium|high 지원. xhigh|max는 high로 정규화한다.
 *  - --output-format json|streaming-json을 사용해 실제 token usage와 text/thought delta를 보존한다.
 *  - 800KB 초과 prompt는 --prompt-file로 전달해 OS ARG_MAX 제한을 우회한다.
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
  private buildCommonArgs(options: ExecuteOptions, outputFormat: 'json' | 'streaming-json'): string[] {
    const model = options.model || this.config.default_model;
    const extraArgs = withoutValueFlag(this.config.extra_args, ['--output-format']);

    // 사용자가 extra_args에 --effort 또는 --reasoning-effort를 이미 넣었으면 건너뛴다.
    const userHasEffort = hasFlag(this.config.extra_args, ['--effort', '--reasoning-effort']);
    const effort = normalizeEffort(options.reasoningEffort);
    const effortArgs = effort && !userHasEffort
      ? ['--effort', effort]
      : [];

    const updateArgs = hasFlag(this.config.extra_args, ['--no-auto-update'])
      ? []
      : ['--no-auto-update'];
    const modelArgs = model ? ['-m', model] : [];

    // OpenAI response_format.json_schema → grok --json-schema (중첩 schema만).
    // 사용자가 extra_args로 스키마를 고정했다면 --model/--effort와 같은 정책으로 그 값을 존중한다.
    const schemaArg = schemaArgument(options.chatResponseFormat);
    const userHasSchema = hasFlag(this.config.extra_args, ['--json-schema']);
    const schemaArgs = schemaArg && !userHasSchema ? ['--json-schema', schemaArg] : [];

    return [
      ...extraArgs,
      ...updateArgs,
      ...effortArgs,
      ...modelArgs,
      ...schemaArgs,
      '--output-format',
      outputFormat,
    ];
  }

  protected buildArgs(
    options: ExecuteOptions,
    outputFormat: 'json' | 'streaming-json' = 'json',
  ): string[] {
    const prompt = convertMessagesToSinglePrompt(options.messages);
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_ARG_BYTES) {
      throw new Error(
        `grok: prompt exceeds ${MAX_PROMPT_ARG_BYTES} bytes in direct argument mode; ` +
        'execute()/executeStream() will use --prompt-file for this payload.'
      );
    }
    return [...this.buildCommonArgs(options, outputFormat), '-p', prompt];
  }

  private async prepareInvocation(
    options: ExecuteOptions,
    outputFormat: 'json' | 'streaming-json',
  ): Promise<PreparedInvocation> {
    const prompt = convertMessagesToSinglePrompt(options.messages);
    if (Buffer.byteLength(prompt, 'utf8') <= MAX_PROMPT_ARG_BYTES) {
      return { args: [...this.buildCommonArgs(options, outputFormat), '-p', prompt] };
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'star-cliproxy-grok-'));
    const promptPath = join(tempDir, 'prompt.txt');
    try {
      await writeFile(promptPath, prompt, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      await rm(tempDir, { recursive: true, force: true });
      throw err;
    }
    return {
      args: [...this.buildCommonArgs(options, outputFormat), '--prompt-file', promptPath],
      cleanup: () => rm(tempDir, { recursive: true, force: true }),
    };
  }

  // json 결과를 사용해 실제 usage와 CLI 오류를 보존한다.
  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const invocation = await this.prepareInvocation({ ...options, stream: false }, 'json');
    const { args } = invocation;
    let stdout = '';
    let stderr = '';
    let exitCode = 1;
    try {
      ({ stdout, stderr, exitCode } = await this.runOnce(args, options.signal));
    } finally {
      await invocation.cleanup?.();
    }

    if (exitCode !== 0) {
      options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout, stderr });
      throw new Error(`grok CLI exited with code ${exitCode}: ${stderr.trim() || stdout.trim()}`);
    }

    options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout, stderr });

    const result = parseLastJsonLine(stdout);
    if (result.type === 'error' || result.error) {
      throw new Error(`grok CLI failed: ${result.message || result.error || 'unknown error'}`);
    }

    // 스키마를 요청했으면 텍스트가 아니라 구조화 출력을 정본으로 쓴다.
    const content = wantsSchemaEnforcement(options.chatResponseFormat)
      ? requireStructuredOutput(grokStructuredOutput(result), 'grok', 'structuredOutput')
      : stripAnsi(result.text ?? result.data ?? '').trim();
    return {
      content,
      usage: toTokenUsage(result.usage, content),
      finishReason: toFinishReason(result.stopReason),
    };
  }

  // grok은 --json-schema로 스키마만 강제할 수 있다. json_object/text는 강제 수단이 없다.
  override supportsResponseFormat(format: ChatResponseFormat): boolean {
    return format.type === 'json_schema';
  }

  // streaming-json의 text/thought/end 이벤트를 실제 ProviderEvent로 변환한다.
  override async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    // 스키마 요청은 완성된 구조화 값 1회 emit으로 통일한다 (structured-output.ts 주석 참고).
    // grok의 delta는 JSON 조각이라 이어붙이면 유효하지만, CLI마다 동작이 갈리므로 버퍼링한다.
    if (shouldBufferStream(options.chatResponseFormat)) {
      const result = await this.execute({ ...options, stream: false });
      yield { type: 'text_delta', text: result.content };
      yield { type: 'usage', usage: result.usage };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }

    const invocation = await this.prepareInvocation({ ...options, stream: true }, 'streaming-json');
    const { args } = invocation;
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
    let endEvent: GrokJsonResult | undefined;

    child.stderr?.on('data', (data: Buffer) => stderrChunks.push(data));
    const closePromise = new Promise<number>((resolve) => {
      child.on('error', (err) => {
        terminalError = new Error(`Failed to spawn grok CLI: ${err.message}`);
        resolve(1);
      });
      child.on('close', (code) => resolve(code ?? 1));
    });

    const timeout = setTimeout(() => {
      terminalError = new Error(`grok CLI timed out after ${this.config.timeout_ms}ms`);
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

        let data: GrokJsonResult;
        try {
          data = JSON.parse(line) as GrokJsonResult;
        } catch {
          continue;
        }

        if (data.type === 'text' && data.text) {
          // Some builds use `text`, while the public contract uses `data`.
          yield { type: 'text_delta', text: data.text };
        } else if (data.type === 'text' && data.data) {
          yield { type: 'text_delta', text: data.data };
        } else if (data.type === 'thought') {
          const thought = data.data ?? data.text;
          if (thought) yield { type: 'thinking', text: thought };
        } else if (data.type === 'error') {
          throw new Error(`grok CLI failed: ${data.message || data.error || 'unknown error'}`);
        } else if (data.type === 'end') {
          endEvent = data;
        }
      }

      const exitCode = await closePromise;
      if (terminalError) throw terminalError;
      if (exitCode !== 0) {
        throw new Error(`grok CLI exited with code ${exitCode}: ${Buffer.concat(stderrChunks).toString('utf-8').trim()}`);
      }
      if (!endEvent) throw new Error('grok CLI stream ended without an end event');

      yield { type: 'usage', usage: toTokenUsage(endEvent.usage) };
      yield {
        type: 'done',
        finishReason: toFinishReason(endEvent.stopReason),
      };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null) gracefulKill(child);
      await invocation.cleanup?.();
      if (options.onDebug) {
        options.onDebug({
          cliArgs: [this.config.cli_path, ...args],
          stderr: Buffer.concat(stderrChunks).toString('utf-8'),
          streamLines: debugLines,
        });
      }
    }
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
