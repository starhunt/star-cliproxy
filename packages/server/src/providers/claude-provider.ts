import type { ExecuteOptions, ExecuteResult, StreamChunk, ProviderConfigYaml } from '@star-cliproxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessages } from '../utils/message-converter.js';

export class ClaudeProvider extends BaseProvider {
  readonly name = 'claude' as const;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const { systemPrompt, userPrompt } = convertMessages(options.messages);
    const model = options.model || this.config.default_model;

    // non-streaming: json, streaming: stream-json --verbose
    // stream-json은 --verbose 필수 (Claude CLI 요구사항)
    const format = options.stream ? 'stream-json' : 'json';
    const args: string[] = [
      '-p', userPrompt,
      '--output-format', format,
      '--model', model,
      '--max-turns', '1',
    ];

    if (options.stream) {
      args.push('--verbose');
    }

    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    // Claude CLI는 --max-tokens를 지원하지 않음 (API 전용 옵션)

    args.push(...this.config.extra_args);

    return args;
  }

  // Claude json 출력에서 결과 추출
  protected override parseNonStreamOutput(stdout: string): ExecuteResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { content: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'error' };
    }

    try {
      const data = JSON.parse(trimmed);

      const content = data.result ?? '';
      const inputTokens = data.usage?.input_tokens ?? 0;
      const outputTokens = data.usage?.output_tokens ?? 0;
      const cacheRead = data.usage?.cache_read_input_tokens ?? 0;
      const cacheCreate = data.usage?.cache_creation_input_tokens ?? 0;

      return {
        content,
        usage: {
          promptTokens: inputTokens + cacheRead + cacheCreate,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens + cacheRead + cacheCreate,
        },
        finishReason: data.stop_reason === 'max_tokens' ? 'length' : 'stop',
      };
    } catch {
      // JSON 파싱 실패 시 텍스트로 처리
      return {
        content: trimmed,
        usage: { promptTokens: 0, completionTokens: Math.ceil(trimmed.length / 4), totalTokens: Math.ceil(trimmed.length / 4) },
        finishReason: 'stop',
      };
    }
  }

  // 스트리밍: stream-json NDJSON을 readline으로 실시간 파싱
  // BaseProvider.executeStream()이 readline + parser로 처리하므로 오버라이드 불필요
  // (buildArgs에서 stream=true일 때 stream-json 포맷 지정)
}
