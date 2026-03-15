import type { ExecuteOptions, ExecuteResult, StreamChunk, ProviderConfigYaml } from '@star-cliproxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';

export class CodexProvider extends BaseProvider {
  readonly name = 'codex' as const;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const prompt = convertMessagesToSinglePrompt(options.messages);
    const model = options.model || this.config.default_model;

    const args: string[] = [
      'exec',
      ...this.config.extra_args,
      '-m', model,
      '--', // 옵션 종료 마커 (prompt가 CLI 플래그로 해석되지 않도록)
      prompt,
    ];

    return args;
  }

  // Codex 출력: NDJSON 스트림 → 각 라인의 content를 추출하되 줄바꿈을 보존
  protected override parseNonStreamOutput(stdout: string): ExecuteResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { content: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'error' };
    }

    // 전체 JSON 파싱 시도
    try {
      const data = JSON.parse(trimmed);
      const content = data.result ?? data.content ?? data.message ?? '';
      return {
        content,
        usage: {
          promptTokens: data.usage?.input_tokens ?? 0,
          completionTokens: data.usage?.output_tokens ?? Math.ceil(content.length / 4),
          totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? Math.ceil(content.length / 4)),
        },
        finishReason: 'stop',
      };
    } catch {
      // JSON 실패 → NDJSON 라인 파싱 시도, 실패하면 stdout 자체를 content로 사용
      const baseResult = super.parseNonStreamOutput(stdout);
      // base 파싱 결과에 줄바꿈이 거의 없으면 stdout 원본 사용 (줄바꿈 보존)
      if (baseResult.content.length > 100 && baseResult.content.split('\n').length < 3) {
        return {
          content: trimmed,
          usage: baseResult.usage,
          finishReason: 'stop',
        };
      }
      return baseResult;
    }
  }

  // 스트리밍: non-streaming 결과를 청크로 분할
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
