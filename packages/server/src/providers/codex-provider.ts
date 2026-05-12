import type { ExecuteOptions, ExecuteResult, ProviderEvent, ProviderConfigYaml, HealthStatus } from '@star-cliproxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import { prepareCodexPrompt } from '../utils/image-extractor.js';
import { CodexAppServerProcess, type CodexAppServerProcessConfig } from './codex-appserver-process.js';
import { CodexAppServerSessionManager } from './codex-appserver-session-manager.js';
import { executeAppServer, executeStreamAppServer, type AppServerExecutorConfig, type AppServerMeta } from './codex-appserver-executor.js';
import { CodexCliSessionManager } from './codex-cli-session-manager.js';
import { mergeProviderConfig } from './provider-override.js';
import { unlink } from 'node:fs/promises';

interface CodexExecuteContext {
  text: string;
  imageFiles: string[];
}

interface CodexExecuteOptions extends ExecuteOptions {
  __codexPrompt?: CodexExecuteContext;
}

// codex exec resume <id>에서 미지원되는 옵션 (검증된 --help 기준).
// 값을 받는 옵션(-s/--sandbox, -C/--cd, --add-dir 등)은 그 다음 토큰도 함께 제거.
// 검증: 'codex exec resume --help' 출력 — 2026-05-12.
const RESUME_UNSUPPORTED_FLAGS_WITH_VALUE = new Set([
  '-s', '--sandbox',
  '-C', '--cd',
  '--add-dir',
  '-p', '--profile',
  '--local-provider',
  '--output-schema',
  '--color',
]);
const RESUME_UNSUPPORTED_FLAGS_STANDALONE = new Set([
  '--oss',
]);

// codex --json 첫 라인에서 thread_id 추출. 잘못된 입력은 null 반환 (silently).
// 보안: 추출 후 UUID 형식 검증으로 인젝션 방어 (SessionManager 키/CLI 인자에 사용되므로).
const THREAD_ID_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export function extractThreadIdFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const data = JSON.parse(trimmed);
    if (!data || data.type !== 'thread.started') return null;
    const candidate = typeof data.thread_id === 'string' ? data.thread_id
      : typeof data.threadId === 'string' ? data.threadId
      : (data.thread && typeof data.thread.id === 'string') ? data.thread.id
      : null;
    if (candidate && THREAD_ID_UUID_RE.test(candidate)) return candidate;
  } catch { /* 첫 라인이 NDJSON이 아니면 무시 */ }
  return null;
}

export function filterResumeUnsupportedArgs(args: string[]): string[] {
  const result: string[] = [];
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) { skipNext = false; continue; }
    // --flag=value 형태
    const eqIdx = arg.indexOf('=');
    const flagPart = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;
    if (RESUME_UNSUPPORTED_FLAGS_WITH_VALUE.has(flagPart)) {
      // --flag value 분리 형태면 다음 토큰까지 스킵 (=가 없을 때만)
      if (eqIdx < 0) skipNext = true;
      continue;
    }
    if (RESUME_UNSUPPORTED_FLAGS_STANDALONE.has(flagPart)) continue;
    result.push(arg);
  }
  return result;
}

export class CodexProvider extends BaseProvider {
  readonly name = 'codex' as const;

  // App Server 모드 전용: 프로세스 + 세션 매니저 (lazy 초기화)
  private appServerProcess: CodexAppServerProcess | null = null;
  private appServerSessionManager: CodexAppServerSessionManager | null = null;
  // CLI 모드(exec resume) 세션 매니저: effective config의 enable_session_reuse가 true인 첫 호출 시 lazy 초기화
  private cliSessionManager: CodexCliSessionManager | null = null;
  // ephemeral 자동 강제 경고를 매핑(alias)별로 1회만 출력하기 위한 dedupe set
  private warnedEphemeralForceAlias = new Set<string>();

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

  // CLI 모드 기준 effective config 계산 (model_mappings.provider_overrides 반영).
  // enable_session_reuse=true면 ephemeral이 true 또는 미지정(기본 true 폴백)일 때 모두 false로 강제 + 경고 1회.
  // 이유: ephemeral=true면 codex가 jsonl을 디스크에 안 남겨 후속 exec resume이 'no rollout found'로 실패함.
  getEffectiveConfig(options: ExecuteOptions): ProviderConfigYaml {
    const merged = mergeProviderConfig(this.config, options.providerOverrides, 'codex');
    const cli = merged.cli_options;
    if (cli?.enable_session_reuse === true && cli?.ephemeral !== false) {
      const aliasKey = options.model || this.config.default_model || '<default>';
      if (!this.warnedEphemeralForceAlias.has(aliasKey)) {
        this.warnedEphemeralForceAlias.add(aliasKey);
        const reason = cli.ephemeral === true ? 'explicitly true' : 'defaulting to true';
        console.warn(`[codex] cli_options.ephemeral disabled because enable_session_reuse is true (was ${reason}, model: ${aliasKey})`);
      }
      merged.cli_options = { ...cli, ephemeral: false };
    }
    return merged;
  }

  // CLI 모드 세션 매니저 lazy 획득 — effective cli_options.session_ttl_ms 반영.
  // 매니저는 인스턴스 하나로 유지하되 TTL은 최초 초기화 시 결정. 후속 호출에서 TTL이 다른 매핑이 들어와도 매니저 TTL은 그대로.
  private ensureCliSessionManager(ttlMs?: number): CodexCliSessionManager {
    if (!this.cliSessionManager) {
      this.cliSessionManager = new CodexCliSessionManager(ttlMs);
    }
    return this.cliSessionManager;
  }

  // 외부에서 CLI 세션 매니저를 참조해야 할 때 (테스트/통합)
  getCliSessionManager(): CodexCliSessionManager | null {
    return this.cliSessionManager;
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

  // CLI 세션 매니저 정리 (테스트/종료 시 호출)
  destroyCliSessionManager(): void {
    this.cliSessionManager?.destroy();
    this.cliSessionManager = null;
    this.warnedEphemeralForceAlias.clear();
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
    const effective = this.getEffectiveConfig(options);
    const model = options.model || effective.default_model;
    const ctx = (options as CodexExecuteOptions).__codexPrompt;

    // resume 분기 판정: effective cli_options.enable_session_reuse + clientKey + 기존 thread 보유
    let resumeThreadId: string | null = null;
    if (effective.cli_options?.enable_session_reuse === true && options.clientKey && !ctx?.imageFiles?.length) {
      const sm = this.ensureCliSessionManager(effective.cli_options.session_ttl_ms);
      const existing = sm.get(options.clientKey, model);
      if (existing) {
        resumeThreadId = existing.threadId;
      }
    }
    // 이미지 첨부가 있으면 첫 호출과 동일한 새 exec로 (resume은 -i를 지원하지만 안전을 위해 첫 호출만 처리)

    // --ephemeral: effective 기준 (false면 jsonl 디스크 저장 — resume 가능)
    const ephemeralEnabled = effective.cli_options?.ephemeral !== false;
    const userHasEphemeral = effective.extra_args.includes('--ephemeral');
    const injectEphemeral = ephemeralEnabled && !userHasEphemeral;

    // 추론 수준 주입
    const userHasReasoning = effective.extra_args.some(
      (arg) => arg === 'model_reasoning_effort' || arg.startsWith('model_reasoning_effort='),
    );
    const reasoningArgs: string[] = [];
    if (options.reasoningEffort && !userHasReasoning) {
      const effort = options.reasoningEffort === 'xhigh' || options.reasoningEffort === 'max'
        ? 'high'
        : options.reasoningEffort;
      reasoningArgs.push('-c', `model_reasoning_effort=${effort}`);
    }

    if (resumeThreadId) {
      // codex exec resume <thread_id> 모드: 일부 옵션(-s/--sandbox, -C/--cd, --add-dir, -p/--profile,
      // --oss, --local-provider, --output-schema, --color)이 미지원. extra_args에서 이들과 그 다음 값 인자를 필터링.
      const filteredExtra = filterResumeUnsupportedArgs(effective.extra_args);
      return [
        'exec',
        'resume',
        resumeThreadId,
        '--json',
        ...(injectEphemeral ? ['--ephemeral'] : []),
        ...reasoningArgs,
        ...filteredExtra,
        ...(model ? ['-m', model] : []),
        '-',
      ];
    }

    const args: string[] = [
      'exec',
      // --json 필수: 없으면 TUI 출력이 되어 stdout 캡처 불가
      '--json',
      ...(injectEphemeral ? ['--ephemeral'] : []),
      ...reasoningArgs,
      ...effective.extra_args,
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
    const result = super.parseNonStreamOutput(stdout);

    // 첫 라인에서 thread_id 추출하여 meta에 실음. CodexProvider.execute에서 result.meta.threadId를 SessionManager.set에 사용.
    const firstLine = stdout.split('\n').find((l) => l.trim().length > 0);
    if (firstLine) {
      const threadId = extractThreadIdFromLine(firstLine);
      if (threadId) {
        return { ...result, meta: { threadId, threadReused: false } };
      }
    }
    return result;
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

    // CLI 모드: effective enable_session_reuse 기준으로 SessionManager 갱신 여부 결정
    const effective = this.getEffectiveConfig(options);
    const sessionReuseEnabled = effective.cli_options?.enable_session_reuse === true && !!options.clientKey;
    const model = options.model || effective.default_model;
    const wasResume = sessionReuseEnabled
      ? !!this.cliSessionManager?.get(options.clientKey!, model)
      : false;

    try {
      const result = await super.execute(ext);
      // thread_id 캡처 후 SessionManager 저장
      if (sessionReuseEnabled && result.meta?.threadId) {
        const sm = this.ensureCliSessionManager(effective.cli_options?.session_ttl_ms);
        sm.set(options.clientKey!, result.meta.threadId, model);
        return { ...result, meta: { ...result.meta, threadReused: wasResume } };
      }
      return result;
    } catch (err) {
      // 에러 시 세션 무효화 (다음 호출은 새 thread)
      if (sessionReuseEnabled && this.cliSessionManager) {
        this.cliSessionManager.invalidate(options.clientKey!);
      }
      throw err;
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

    // CLI 모드: thread_started 이벤트 가로채서 SessionManager 갱신.
    // thread_started는 외부 SSE 변환기에서 default 분기로 무시되도록 ProviderEvent union에 등록됨.
    const effective = this.getEffectiveConfig(options);
    const sessionReuseEnabled = effective.cli_options?.enable_session_reuse === true && !!options.clientKey;
    const model = options.model || effective.default_model;

    try {
      for await (const event of super.executeStream(ext)) {
        if (event.type === 'thread_started') {
          if (sessionReuseEnabled) {
            const sm = this.ensureCliSessionManager(effective.cli_options?.session_ttl_ms);
            sm.set(options.clientKey!, event.threadId, model);
          }
          // 내부 이벤트는 외부로 노출하지 않음 (HTTP 라우트가 별도 처리하지 않도록)
          continue;
        }
        yield event;
      }
    } catch (err) {
      if (sessionReuseEnabled && this.cliSessionManager) {
        this.cliSessionManager.invalidate(options.clientKey!);
      }
      throw err;
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
