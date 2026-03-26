import type { ExecuteOptions, ExecuteResult, StreamChunk, ProviderConfigYaml } from '@star-cliproxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';

export class CodexProvider extends BaseProvider {
  readonly name = 'codex' as const;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();
  }

  // stdin으로 프롬프트 전달 (Windows shell 모드에서 인자 따옴표 문제 방지)
  protected override getStdinData(options: ExecuteOptions): string {
    return convertMessagesToSinglePrompt(options.messages);
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const model = options.model || this.config.default_model;

    const args: string[] = [
      'exec',
      // --json 필수: 없으면 TUI 출력이 되어 stdout 캡처 불가
      '--json',
      ...this.config.extra_args,
      // 모델 지정 (빈 값이면 Codex 기본 모델 사용)
      ...(model ? ['-m', model] : []),
      '-', // stdin에서 프롬프트 읽기
    ];

    return args;
  }

  // Codex --json 출력: NDJSON 이벤트 스트림에서 텍스트 추출
  protected override parseNonStreamOutput(stdout: string): ExecuteResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { content: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'error' };
    }

    // 단일 JSON 객체인 경우 (구형 포맷)
    try {
      const data = JSON.parse(trimmed);
      // 배열이나 NDJSON이 아닌 단일 객체
      if (typeof data === 'object' && !Array.isArray(data) && data.type === undefined) {
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
      }
    } catch { /* NDJSON → 라인별 파싱으로 폴백 */ }

    // NDJSON 라인별 파싱 (item.completed → text 추출)
    return super.parseNonStreamOutput(stdout);
  }

  // 스트리밍: --json JSONL을 readline으로 실시간 파싱
  // BaseProvider.executeStream()이 readline + parser로 처리하므로 오버라이드 불필요
  // (buildArgs에서 stream=true일 때 --json 플래그 추가)
}
