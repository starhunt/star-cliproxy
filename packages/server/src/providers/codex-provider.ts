import type { ExecuteOptions, ExecuteResult, StreamChunk, ProviderConfigYaml, HealthStatus } from '@star-cliproxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import { CodexAppServerProcess, type CodexAppServerProcessConfig } from './codex-appserver-process.js';
import { CodexAppServerSessionManager } from './codex-appserver-session-manager.js';
import { executeAppServer, executeStreamAppServer, type AppServerExecutorConfig, type AppServerMeta } from './codex-appserver-executor.js';

export class CodexProvider extends BaseProvider {
  readonly name = 'codex' as const;

  // App Server 모드 전용: 프로세스 + 세션 매니저 (lazy 초기화)
  private appServerProcess: CodexAppServerProcess | null = null;
  private appServerSessionManager: CodexAppServerSessionManager | null = null;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();

    // App Server 모드일 때 프로세스 + 세션 매니저 초기화
    if (this.isAppServerMode) {
      this.initAppServer();
    }
  }

  private get isAppServerMode(): boolean {
    return this.config.mode === 'app-server';
  }

  // --- App Server 초기화/해제 ---

  private initAppServer(): void {
    const options = this.config.app_server_options ?? {};
    const ttl = options.session_ttl_ms;

    const processConfig: CodexAppServerProcessConfig = {
      cliPath: this.config.cli_path,
      options,
      env: this.getCleanEnv(),
      workingDir: this.workingDir,
    };

    this.appServerProcess = new CodexAppServerProcess(processConfig);
    this.appServerProcess.start().catch((err) => {
      console.error('[codex] app-server initial start failed:', err.message);
    });

    if (options.enable_session_reuse !== false) {
      this.appServerSessionManager = new CodexAppServerSessionManager(ttl);
    }
  }

  private destroyAppServer(): void {
    this.appServerProcess?.stop().catch(() => { /* 종료 실패 무시 */ });
    this.appServerProcess = null;
    this.appServerSessionManager?.destroy();
    this.appServerSessionManager = null;
  }

  private buildAppServerConfig(options: ExecuteOptions): AppServerExecutorConfig {
    return {
      model: options.model || this.config.default_model,
      options: this.config.app_server_options ?? {},
      process: this.appServerProcess!,
      sessionManager: this.appServerSessionManager ?? undefined,
      clientKey: options.clientKey,
      timeoutMs: this.config.timeout_ms,
    };
  }

  private appServerDebugArgs(model: string, meta?: AppServerMeta): string[] {
    const args = ['[app-server]', `model=${model}`];
    if (meta) {
      args.push(`thread=${meta.threadId ?? 'none'}`);
      args.push(`reused=${meta.threadReused}`);
      if (meta.retried) args.push('retried=true');
    }
    return args;
  }

  // --- CLI 모드 전용 메서드 (기존 동작 유지) ---

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

  // --- mode 기반 분기 ---

  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    if (this.isAppServerMode) {
      if (!this.appServerProcess?.isAlive()) {
        throw new Error('Codex app-server process is not running');
      }
      const config = this.buildAppServerConfig(options);
      const result = await executeAppServer(options, config);
      const model = options.model || this.config.default_model;
      // App Server 모드에서도 onDebug 콜백 호출 (디버그 로그 PENDING 방지)
      options.onDebug?.({
        cliArgs: this.appServerDebugArgs(model, result.appServerMeta),
        stdout: result.content,
      });
      return result;
    }
    return super.execute(options);
  }

  override async *executeStream(options: ExecuteOptions): AsyncIterable<StreamChunk> {
    if (this.isAppServerMode) {
      if (!this.appServerProcess?.isAlive()) {
        throw new Error('Codex app-server process is not running');
      }
      const streamLines: string[] = [];
      let streamMeta: AppServerMeta | undefined;
      const config = this.buildAppServerConfig(options);
      config.onAppServerMeta = (meta) => { streamMeta = meta; };

      for await (const chunk of executeStreamAppServer(options, config)) {
        if (chunk.type === 'delta' && chunk.content) {
          streamLines.push(chunk.content);
        }
        yield chunk;
      }
      const model = options.model || this.config.default_model;
      // App Server 모드에서도 onDebug 콜백 호출 (디버그 로그 PENDING 방지)
      options.onDebug?.({
        cliArgs: this.appServerDebugArgs(model, streamMeta),
        streamLines,
      });
      return;
    }
    yield* super.executeStream(options);
  }

  override async checkHealth(): Promise<HealthStatus> {
    if (this.isAppServerMode) {
      return this.appServerProcess?.isAlive() ? 'healthy' : 'unhealthy';
    }
    return super.checkHealth();
  }

  // 런타임 설정 변경 시 App Server 프로세스 재초기화
  override updateConfig(partial: Partial<ProviderConfigYaml>): void {
    const wasAppServer = this.isAppServerMode;
    super.updateConfig(partial);

    // CLI → App Server 전환: 프로세스 시작
    if (!wasAppServer && this.isAppServerMode) {
      this.initAppServer();
    }

    // App Server → CLI 전환: 프로세스 종료
    if (wasAppServer && !this.isAppServerMode) {
      this.destroyAppServer();
    }
  }
}
