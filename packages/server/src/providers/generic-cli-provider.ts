import type { ExecuteOptions, ExecuteResult, GenericCliProviderConfig } from '@star-cliproxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import { registerParser, PlainTextParser } from '../utils/stream-transformer.js';

// NDJSON 필드 기반 스트리밍 파서 (Generic CLI 프로바이더용)
class NdjsonFieldParser extends PlainTextParser {
  constructor(
    private readonly contentField: string,
    private readonly doneIndicator?: string,
  ) {
    super();
  }

  override parse(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return null;

    // done 인디케이터 체크
    if (this.doneIndicator && trimmed === this.doneIndicator) {
      return { type: 'done' as const };
    }

    try {
      const data = JSON.parse(trimmed);
      const content = data[this.contentField];
      if (typeof content === 'string' && content) {
        return { type: 'delta' as const, content };
      }
      return null;
    } catch {
      // JSON 파싱 실패 시 plain text fallback
      return { type: 'delta' as const, content: trimmed };
    }
  }
}

export class GenericCliProvider extends BaseProvider {
  // name은 config에서 동적으로 결정됨
  readonly name: string;

  private readonly genericConfig: GenericCliProviderConfig;

  constructor(name: string, config: GenericCliProviderConfig) {
    super(config);
    this.name = name;
    this.genericConfig = config;
    this.initParser();
  }

  // streaming_enabled + stream_content_field가 있으면 NDJSON 파서 등록
  protected override initParser() {
    if (
      this.genericConfig.streaming_enabled &&
      this.genericConfig.stream_content_field
    ) {
      registerParser(this.name, () =>
        new NdjsonFieldParser(
          this.genericConfig.stream_content_field!,
          this.genericConfig.stream_done_indicator,
        ),
      );
    }
    // 등록 후 super.initParser()로 레지스트리에서 파서 인스턴스 획득
    super.initParser();
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const model = options.model || this.config.default_model;

    // 스트리밍 시 stream_args_template 우선 사용
    const template =
      options.stream && this.genericConfig.stream_args_template
        ? this.genericConfig.stream_args_template
        : this.genericConfig.args_template;

    // {model} 플레이스홀더 치환
    const args = template.map((arg) => arg.replace(/\{model\}/g, model));

    // arg 모드: {prompt} 플레이스홀더 치환
    if (this.genericConfig.prompt_mode === 'arg') {
      const prompt = convertMessagesToSinglePrompt(options.messages);
      for (let i = 0; i < args.length; i++) {
        args[i] = args[i].replace(/\{prompt\}/g, prompt);
      }
    }

    // extra_args 추가
    args.push(...this.config.extra_args);

    return args;
  }

  // stdin 모드: 프롬프트를 stdin으로 전달
  // arg 모드: undefined (buildArgs에서 {prompt} 치환으로 처리)
  protected override getStdinData(options: ExecuteOptions): string | undefined {
    if (this.genericConfig.prompt_mode === 'stdin') {
      return convertMessagesToSinglePrompt(options.messages);
    }
    return undefined;
  }

  // non-streaming 출력 파싱
  protected override parseNonStreamOutput(stdout: string): ExecuteResult {
    const trimmed = stdout.trim();

    if (!trimmed) {
      return {
        content: '',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: 'error',
      };
    }

    if (this.genericConfig.output_mode === 'json_field') {
      const field = this.genericConfig.output_json_content_field;
      if (field) {
        try {
          const data = JSON.parse(trimmed);
          const content = typeof data[field] === 'string' ? data[field] : '';
          const tokens = Math.ceil(content.length / 4);
          return {
            content,
            usage: { promptTokens: 0, completionTokens: tokens, totalTokens: tokens },
            finishReason: 'stop',
          };
        } catch {
          // JSON 파싱 실패 시 plain text 폴백
        }
      }
    }

    // plain_text 모드 또는 폴백
    const tokens = Math.ceil(trimmed.length / 4);
    return {
      content: trimmed,
      usage: { promptTokens: 0, completionTokens: tokens, totalTokens: tokens },
      finishReason: 'stop',
    };
  }

  // 헬스 체크: health_check_args 설정값 사용 (기본: ["--version"])
  // BaseProvider.checkHealth()는 ["--version"] 하드코딩이므로 오버라이드
  override async checkHealth() {
    const args = this.genericConfig.health_check_args ?? ['--version'];
    try {
      const child = this.spawnProcess(args);
      child.stdin?.end();
      const exitCode = await new Promise<number>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          resolve(1);
        }, 10_000);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve(code ?? 1);
        });
        child.on('error', () => {
          clearTimeout(timer);
          resolve(1);
        });
      });
      return exitCode === 0 ? ('healthy' as const) : ('unhealthy' as const);
    } catch {
      return 'unhealthy' as const;
    }
  }

  // 대시보드용: 현재 generic 설정 반환
  getConfig(): GenericCliProviderConfig {
    return { ...this.genericConfig };
  }

  // 대시보드용: 런타임 설정 변경
  updateConfig(partial: Partial<GenericCliProviderConfig>): void {
    Object.assign(this.config, partial);
    Object.assign(this.genericConfig, partial);
  }
}
