import type { ExecuteOptions, ExecuteResult, StreamChunk, ProviderConfigYaml, HealthStatus } from '@star-cliproxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessages } from '../utils/message-converter.js';
import { executeSdk, executeStreamSdk, type SdkExecutorConfig, type SdkMeta } from './claude-sdk-executor.js';
import { ClaudeSdkSessionManager } from './claude-sdk-session-manager.js';

export class ClaudeProvider extends BaseProvider {
  readonly name = 'claude' as const;

  // SDK 모드 전용: 세션 매니저 (lazy 초기화)
  private sessionManager: ClaudeSdkSessionManager | null = null;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();

    // SDK 모드일 때 세션 매니저 초기화
    if (this.isSDKMode) {
      const ttl = config.sdk_options?.session_ttl_ms;
      this.sessionManager = new ClaudeSdkSessionManager(ttl);
    }
  }

  private get isSDKMode(): boolean {
    return this.config.mode === 'sdk';
  }

  private buildSdkConfig(options: ExecuteOptions, clientKey?: string): SdkExecutorConfig {
    return {
      model: options.model || this.config.default_model,
      sdkOptions: this.config.sdk_options ?? {},
      workingDir: this.workingDir,
      timeoutMs: this.config.timeout_ms,
      cleanEnv: this.getCleanEnv(),
      cliPath: this.config.cli_path,
      sessionManager: this.sessionManager ?? undefined,
      clientKey,
    };
  }

  // --- CLI 모드 전용 메서드 (기존 동작 유지) ---

  protected override getStdinData(options: ExecuteOptions): string {
    const { userPrompt } = convertMessages(options.messages);
    return userPrompt;
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const { systemPrompt } = convertMessages(options.messages);
    const model = options.model || this.config.default_model;

    // non-streaming: json, streaming: stream-json --verbose
    // stream-json은 --verbose 필수 (Claude CLI 요구사항)
    const format = options.stream ? 'stream-json' : 'json';
    const args: string[] = [
      '-p', '-', // stdin에서 프롬프트 읽기 (ARG_MAX 제한 우회)
      '--output-format', format,
      '--model', model,
      '--max-turns', '5',
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

  // --- mode 기반 분기 ---

  private sdkDebugArgs(model: string, meta?: SdkMeta): string[] {
    const args = ['[sdk-mode]', `model=${model}`];
    if (meta) {
      args.push(`session=${meta.sessionId ?? 'none'}`);
      args.push(`reused=${meta.sessionReused}`);
      if (meta.retried) args.push('retried=true');
    }
    return args;
  }

  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    if (this.isSDKMode) {
      const result = await executeSdk(options, this.buildSdkConfig(options, options.clientKey));
      const model = options.model || this.config.default_model;
      // SDK 모드에서도 onDebug 콜백 호출 (디버그 로그 PENDING 방지)
      options.onDebug?.({
        cliArgs: this.sdkDebugArgs(model, result.sdkMeta),
        stdout: result.content,
      });
      return result;
    }
    return super.execute(options);
  }

  override async *executeStream(options: ExecuteOptions): AsyncIterable<StreamChunk> {
    if (this.isSDKMode) {
      const sdkLines: string[] = [];
      let streamMeta: SdkMeta | undefined;
      const sdkConfig = this.buildSdkConfig(options, options.clientKey);
      sdkConfig.onSdkMeta = (meta) => { streamMeta = meta; };

      for await (const chunk of executeStreamSdk(options, sdkConfig)) {
        if (chunk.type === 'delta' && chunk.content) {
          sdkLines.push(chunk.content);
        }
        yield chunk;
      }
      const model = options.model || this.config.default_model;
      // SDK 모드에서도 onDebug 콜백 호출 (디버그 로그 PENDING 방지)
      options.onDebug?.({
        cliArgs: this.sdkDebugArgs(model, streamMeta),
        streamLines: sdkLines,
      });
      return;
    }
    yield* super.executeStream(options);
  }

  override async checkHealth(): Promise<HealthStatus> {
    // SDK 모드에서도 CLI 바이너리 존재 확인 (SDK가 내부적으로 CLI를 스폰하므로)
    return super.checkHealth();
  }

  // 런타임 설정 변경 시 세션 매니저 재초기화
  override updateConfig(partial: Partial<ProviderConfigYaml>): void {
    const wasSDKMode = this.isSDKMode;
    super.updateConfig(partial);

    // CLI → SDK 전환 시 세션 매니저 생성
    if (!wasSDKMode && this.isSDKMode && !this.sessionManager) {
      const ttl = this.config.sdk_options?.session_ttl_ms;
      this.sessionManager = new ClaudeSdkSessionManager(ttl);
    }

    // SDK → CLI 전환 시 세션 매니저 해제
    if (wasSDKMode && !this.isSDKMode && this.sessionManager) {
      this.sessionManager.destroy();
      this.sessionManager = null;
    }
  }
}
