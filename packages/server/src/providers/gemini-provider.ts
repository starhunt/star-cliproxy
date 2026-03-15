import type { ExecuteOptions, ExecuteResult, StreamChunk, ProviderConfigYaml } from '@star-cliproxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';

export class GeminiProvider extends BaseProvider {
  readonly name = 'gemini' as const;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const prompt = convertMessagesToSinglePrompt(options.messages);
    const model = options.model || this.config.default_model;

    const args: string[] = [
      '-p', prompt,
      '-m', model,
      '-o', options.stream ? 'stream-json' : 'json',
    ];

    // 추가 인수 (--approval-mode yolo 등)
    args.push(...this.config.extra_args);

    return args;
  }

  // Gemini json 출력에서 결과 추출 (전체 JSON 파싱으로 줄바꿈 보존)
  protected override parseNonStreamOutput(stdout: string): ExecuteResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { content: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'error' };
    }

    try {
      const data = JSON.parse(trimmed);

      // Gemini CLI json 출력 형식: { result, usage, ... }
      const content = data.result ?? data.text ?? data.content ?? '';
      const inputTokens = data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? 0;
      const outputTokens = data.usage?.output_tokens ?? data.usage?.completion_tokens ?? 0;

      return {
        content,
        usage: {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        finishReason: 'stop',
      };
    } catch {
      // JSON 파싱 실패 → NDJSON fallback (base의 라인 파싱)
      return super.parseNonStreamOutput(stdout);
    }
  }

  // 스트리밍: non-streaming JSON 결과를 청크로 분할하여 emit
  override async *executeStream(options: ExecuteOptions): AsyncIterable<StreamChunk> {
    const result = await this.execute(options);
    const content = result.content;

    const chunkSize = 20;
    for (let i = 0; i < content.length; i += chunkSize) {
      const chunk = content.substring(i, i + chunkSize);
      yield { type: 'delta', content: chunk };
    }

    yield { type: 'done', usage: result.usage };
  }
}
