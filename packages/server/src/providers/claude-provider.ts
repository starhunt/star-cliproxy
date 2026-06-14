import type { ExecuteOptions, ExecuteResult, ProviderEvent, ProviderConfigYaml, HealthStatus } from '@star-cliproxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessages } from '../utils/message-converter.js';
import { executeSdk, executeStreamSdk, type SdkExecutorConfig, type SdkMeta } from './claude-sdk-executor.js';
import { ClaudeSdkSessionManager } from './claude-sdk-session-manager.js';
import { executeChannel, executeStreamChannel, type ChannelExecutorConfig } from './claude-channel-executor.js';
import { mergeProviderConfig } from './provider-override.js';
import { channelBridgeManager } from '../channel-bridge/manager.js';

// channel-worker 모드 health: bridge /health 확인 (CLI 존재가 아니라 실제 처리 가능 여부)
async function pingBridgeHealth(baseUrl: string, apiKey?: string): Promise<boolean> {
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/health`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

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

  private getEffectiveConfig(options: ExecuteOptions): ProviderConfigYaml {
    return mergeProviderConfig(this.config, options.providerOverrides, 'claude');
  }

  private ensureSdkSessionManager(ttlMs?: number): ClaudeSdkSessionManager {
    if (!this.sessionManager) {
      this.sessionManager = new ClaudeSdkSessionManager(ttlMs);
    }
    return this.sessionManager;
  }

  private buildSdkConfig(
    options: ExecuteOptions,
    effective: ProviderConfigYaml,
    clientKey?: string,
  ): SdkExecutorConfig {
    return {
      model: options.model || effective.default_model,
      sdkOptions: effective.sdk_options ?? {},
      workingDir: effective.working_dir ?? this.workingDir,
      timeoutMs: effective.timeout_ms,
      cleanEnv: this.getCleanEnv(),
      cliPath: effective.cli_path,
      sessionManager: this.ensureSdkSessionManager(effective.sdk_options?.session_ttl_ms),
      clientKey,
    };
  }

  private buildChannelConfig(options: ExecuteOptions, effective: ProviderConfigYaml): ChannelExecutorConfig {
    const channelOptions = { ...(effective.channel_options ?? {}) };
    // managed bridge일 때 endpoint_url을 비워두면 bridge_port로 자동 유추 (대시보드 안내와 일치)
    if (!channelOptions.endpoint_url && channelOptions.managed) {
      channelOptions.endpoint_url = `http://127.0.0.1:${channelOptions.bridge_port ?? 8788}`;
    }
    return {
      model: options.model || effective.default_model,
      channelOptions,
      timeoutMs: effective.timeout_ms,
    };
  }

  // --- CLI 모드 전용 메서드 (기존 동작 유지) ---

  protected override getStdinData(options: ExecuteOptions): string {
    const { userPrompt } = convertMessages(options.messages);
    return userPrompt;
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const effective = this.getEffectiveConfig(options);
    const { systemPrompt } = convertMessages(options.messages);
    const model = options.model || effective.default_model;

    // non-streaming: json, streaming: stream-json --verbose
    // stream-json은 --verbose 필수 (Claude CLI 요구사항)
    const format = options.stream ? 'stream-json' : 'json';
    const args: string[] = [
      '-p', '-', // stdin에서 프롬프트 읽기 (ARG_MAX 제한 우회)
      '--output-format', format,
      '--model', model,
      '--max-turns', '50',
    ];

    if (options.stream) {
      args.push('--verbose');
    }

    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    // Claude CLI는 --max-tokens를 지원하지 않음 (API 전용 옵션)

    // 추론 수준 주입 (사용자가 extra_args로 직접 넣지 않은 경우에만)
    if (options.reasoningEffort && !effective.extra_args.includes('--effort')) {
      args.push('--effort', options.reasoningEffort);
    }

    args.push(...effective.extra_args);

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
    const effective = this.getEffectiveConfig(options);
    if (effective.mode === 'sdk') {
      const result = await executeSdk(options, this.buildSdkConfig(options, effective, options.clientKey));
      const model = options.model || effective.default_model;
      // SDK 모드에서도 onDebug 콜백 호출 (디버그 로그 PENDING 방지)
      options.onDebug?.({
        cliArgs: this.sdkDebugArgs(model, result.sdkMeta),
        stdout: result.content,
      });
      return result;
    }
    if (effective.mode === 'channel-worker') {
      return executeChannel(options, this.buildChannelConfig(options, effective));
    }
    return super.execute(options);
  }

  override async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    const effective = this.getEffectiveConfig(options);
    if (effective.mode === 'sdk') {
      const sdkLines: string[] = [];
      let streamMeta: SdkMeta | undefined;
      const sdkConfig = this.buildSdkConfig(options, effective, options.clientKey);
      sdkConfig.onSdkMeta = (meta) => { streamMeta = meta; };

      for await (const event of executeStreamSdk(options, sdkConfig)) {
        if (event.type === 'text_delta') {
          sdkLines.push(event.text);
        }
        yield event;
      }
      const model = options.model || effective.default_model;
      // SDK 모드에서도 onDebug 콜백 호출 (디버그 로그 PENDING 방지)
      options.onDebug?.({
        cliArgs: this.sdkDebugArgs(model, streamMeta),
        streamLines: sdkLines,
      });
      return;
    }
    if (effective.mode === 'channel-worker') {
      yield* executeStreamChannel(options, this.buildChannelConfig(options, effective));
      return;
    }
    yield* super.executeStream(options);
  }

  override async checkHealth(): Promise<HealthStatus> {
    // channel-worker 모드는 CLI 존재가 아니라 실제 처리 주체인 bridge의 상태를 본다.
    if (this.config.mode === 'channel-worker') {
      const ch = this.config.channel_options ?? {};
      if (ch.managed) {
        // 내장 bridge: manager가 띄운 프로세스의 running + healthy
        const status = await channelBridgeManager.status();
        return status.running && status.healthy ? 'healthy' : 'unhealthy';
      }
      // 외부 bridge: endpoint(없으면 bridge_port로 유추) /health ping
      const baseUrl = ch.endpoint_url ?? `http://127.0.0.1:${ch.bridge_port ?? 8788}`;
      return (await pingBridgeHealth(baseUrl, ch.api_key)) ? 'healthy' : 'unhealthy';
    }
    // cli / sdk 모드: CLI 바이너리 존재 확인 (SDK도 내부적으로 CLI를 스폰)
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
