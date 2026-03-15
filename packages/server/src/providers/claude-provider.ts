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

    // json 포맷 사용 (stream-json은 환경에 따라 출력 버퍼링 이슈)
    const args: string[] = [
      '-p', userPrompt,
      '--output-format', 'json',
      '--model', model,
      '--max-turns', '1',
    ];

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

  // 스트리밍: json 결과를 받아서 청크로 분할하여 emit
  override async *executeStream(options: ExecuteOptions): AsyncIterable<StreamChunk> {
    // Claude는 json 포맷으로 전체 결과를 받은 후 시뮬레이트 스트리밍
    const result = await this.execute(options);
    const content = result.content;

    // 일정 크기로 분할하여 스트리밍 시뮬레이션
    const chunkSize = 20;
    for (let i = 0; i < content.length; i += chunkSize) {
      const chunk = content.substring(i, i + chunkSize);
      yield { type: 'delta', content: chunk };
    }

    yield { type: 'done', usage: result.usage };
  }
}
