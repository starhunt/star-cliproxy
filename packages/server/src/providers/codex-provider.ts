import type { ExecuteOptions, ExecuteResult, ProviderEvent, ProviderConfigYaml, HealthStatus } from '@star-cliproxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import { prepareCodexPrompt } from '../utils/image-extractor.js';
import { CodexAppServerProcess, type CodexAppServerProcessConfig } from './codex-appserver-process.js';
import { CodexAppServerSessionManager } from './codex-appserver-session-manager.js';
import { executeAppServer, executeStreamAppServer, type AppServerExecutorConfig, type AppServerMeta } from './codex-appserver-executor.js';
import { unlink } from 'node:fs/promises';

interface CodexExecuteContext {
  text: string;
  imageFiles: string[];
}

interface CodexExecuteOptions extends ExecuteOptions {
  __codexPrompt?: CodexExecuteContext;
}

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
    const ctx = (options as CodexExecuteOptions).__codexPrompt;
    if (ctx) return ctx.text;
    return convertMessagesToSinglePrompt(options.messages);
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const model = options.model || this.config.default_model;
    const ctx = (options as CodexExecuteOptions).__codexPrompt;

    // --ephemeral 기본 활성화: 세션 jsonl이 ~/.codex/sessions에 누적되는 것을 차단.
    // cli_options.ephemeral === false일 때만 비활성. extra_args에 사용자가 직접
    // 추가했으면 중복 주입 방지.
    const ephemeralEnabled = this.config.cli_options?.ephemeral !== false;
    const userHasEphemeral = this.config.extra_args.includes('--ephemeral');
    const injectEphemeral = ephemeralEnabled && !userHasEphemeral;

    // 추론 수준 주입: -c model_reasoning_effort=<level>.
    // Codex는 xhigh/max를 지원하지 않으므로 'high'로 폴백.
    // 사용자가 extra_args에 model_reasoning_effort를 직접 넣었으면 건너뜀.
    const userHasReasoning = this.config.extra_args.some(
      (arg) => arg === 'model_reasoning_effort' || arg.startsWith('model_reasoning_effort='),
    );
    const reasoningArgs: string[] = [];
    if (options.reasoningEffort && !userHasReasoning) {
      const effort = options.reasoningEffort === 'xhigh' || options.reasoningEffort === 'max'
        ? 'high'
        : options.reasoningEffort;
      reasoningArgs.push('-c', `model_reasoning_effort=${effort}`);
    }

    const args: string[] = [
      'exec',
      // --json 필수: 없으면 TUI 출력이 되어 stdout 캡처 불가
      '--json',
      ...(injectEphemeral ? ['--ephemeral'] : []),
      ...reasoningArgs,
      ...this.config.extra_args,
      ...((ctx?.imageFiles ?? []).flatMap((file) => ['--image', file])),
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
    const { prompt, imageFiles, tempFiles } = await prepareCodexPrompt(options.messages);
    const ext: CodexExecuteOptions = {
      ...options,
      __codexPrompt: { text: prompt, imageFiles },
    };
    try {
      return await super.execute(ext);
    } finally {
      await Promise.allSettled(tempFiles.map((file) => unlink(file)));
    }
  }

  override async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    if (this.isAppServerMode) {
      if (!this.appServerProcess?.isAlive()) {
        throw new Error('Codex app-server process is not running');
      }
      const streamLines: string[] = [];
      let streamMeta: AppServerMeta | undefined;
      const config = this.buildAppServerConfig(options);
      config.onAppServerMeta = (meta) => { streamMeta = meta; };

      for await (const event of executeStreamAppServer(options, config)) {
        if (event.type === 'text_delta') {
          streamLines.push(event.text);
        }
        yield event;
      }
      const model = options.model || this.config.default_model;
      // App Server 모드에서도 onDebug 콜백 호출 (디버그 로그 PENDING 방지)
      options.onDebug?.({
        cliArgs: this.appServerDebugArgs(model, streamMeta),
        streamLines,
      });
      return;
    }
    const { prompt, imageFiles, tempFiles } = await prepareCodexPrompt(options.messages);
    const ext: CodexExecuteOptions = {
      ...options,
      __codexPrompt: { text: prompt, imageFiles },
    };
    try {
      yield* super.executeStream(ext);
    } finally {
      await Promise.allSettled(tempFiles.map((file) => unlink(file)));
    }
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
