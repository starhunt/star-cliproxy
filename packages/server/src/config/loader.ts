import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { AppConfig, ProviderConfigYaml, PluginEntry, ProviderOverrides, ReasoningEffort } from '@star-cliproxy/shared';
import { rawConfigSchema, type RawProviderConfig } from './schema.js';
import {
  DEFAULT_SERVER_PORT,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_HOST,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CACHE_TTL_SECONDS,
  DEFAULT_CACHE_MAX_ENTRIES,
  DEFAULT_RATE_LIMIT_RPM,
  DEFAULT_RATE_LIMIT_RPD,
  DEFAULT_MAX_MESSAGE_COUNT,
  DEFAULT_MAX_MESSAGE_LENGTH,
  DEFAULT_MAX_PROMPT_LENGTH,
  DEFAULT_MAX_RESPONSE_LENGTH,
  DEFAULT_BODY_LIMIT_BYTES,
  isReasoningEffort,
} from '@star-cliproxy/shared';

// 사용자 입력 reasoning_effort 정규화: 문자열을 trim+lowercase 후 화이트리스트 검증.
// 알 수 없는 값은 silently 무시 (provider가 default 동작).
function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return isReasoningEffort(normalized) ? normalized : undefined;
}

// model_mappings.provider_overrides 정규화: 화이트리스트 키만 통과.
// 화이트리스트 검증과 deep merge는 런타임에서 mergeProviderConfig가 수행하지만,
// 여기서는 명확한 타입/구조만 보장한다 (잘못된 타입 자체는 silently drop).
function normalizeProviderOverrides(value: unknown): ProviderOverrides | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: ProviderOverrides = {};
  if (Array.isArray(raw.extra_args)) {
    out.extra_args = raw.extra_args.filter((a): a is string => typeof a === 'string');
  }
  if (typeof raw.timeout_ms === 'number' && raw.timeout_ms > 0) {
    out.timeout_ms = raw.timeout_ms;
  }
  if (typeof raw.working_dir === 'string' && raw.working_dir.trim()) {
    out.working_dir = raw.working_dir;
  }
  if (raw.cli_options && typeof raw.cli_options === 'object' && !Array.isArray(raw.cli_options)) {
    const rawCli = raw.cli_options as Record<string, unknown>;
    const cli: NonNullable<ProviderOverrides['cli_options']> = {};
    if (typeof rawCli.ephemeral === 'boolean') cli.ephemeral = rawCli.ephemeral;
    if (typeof rawCli.enable_session_reuse === 'boolean') cli.enable_session_reuse = rawCli.enable_session_reuse;
    if (typeof rawCli.session_ttl_ms === 'number' && rawCli.session_ttl_ms > 0) cli.session_ttl_ms = rawCli.session_ttl_ms;
    if (Object.keys(cli).length > 0) out.cli_options = cli;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// 환경변수 치환: "${VAR_NAME}" → process.env.VAR_NAME
function substituteEnvVars(text: string): string {
  return text.replace(/\$\{(\w+)\}/g, (_, varName) => {
    return process.env[varName] ?? '';
  });
}

function defaultProviderConfig(cliPath: string, defaultModel: string): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: cliPath,
    default_model: defaultModel,
    max_concurrent: DEFAULT_MAX_CONCURRENT,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    extra_args: [],
  };
}

// 빌트인 프로바이더 기본값
const BUILTIN_DEFAULTS: Record<string, { cliPath: string; defaultModel: string }> = {
  claude: { cliPath: 'claude', defaultModel: 'claude-sonnet-4-6' },
  codex: { cliPath: 'codex', defaultModel: '' },
  copilot: { cliPath: 'copilot', defaultModel: 'claude-sonnet-4-6' },
  gemini: { cliPath: 'gemini', defaultModel: 'gemini-2.5-pro' },
  // agy 1.0.0은 -m/--model 미지원 → defaultModel은 응답 메타데이터 표시용
  agy: { cliPath: 'agy', defaultModel: 'antigravity' },
  // xAI Grok Build CLI (`grok`) — -m/--model 지원, 헤드리스 `grok -p`
  grok: { cliPath: 'grok', defaultModel: 'grok-build' },
};

export function loadConfig(configPath?: string): AppConfig {
  const resolvedPath = configPath ?? resolve(process.cwd(), 'config.yaml');

  let rawConfig: unknown = {};

  if (existsSync(resolvedPath)) {
    const content = readFileSync(resolvedPath, 'utf-8');
    const substituted = substituteEnvVars(content);
    rawConfig = parseYaml(substituted) ?? {};
  }

  // Zod 스키마 검증 (#30): 잘못된 타입/범위는 기동 시점에 경로 포함 에러로 거부
  const parsed = rawConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw new Error(
      `config 검증 실패 (${resolvedPath}):\n${z.prettifyError(parsed.error)}`,
    );
  }

  const {
    server,
    dashboard,
    database,
    auth,
    providers,
    rate_limits: rateLimits,
    cache,
    validation,
    model_mappings: modelMappings,
    plugins: rawPlugins,
  } = parsed.data;

  const globalLimits = rateLimits?.global;
  const perProvider = rateLimits?.per_provider;

  const initialKeys = auth?.initial_keys ?? [];

  // 빌트인 프로바이더 설정 병합
  const providerConfigs: Record<string, ProviderConfigYaml> = {};
  for (const [name, defaults] of Object.entries(BUILTIN_DEFAULTS)) {
    providerConfigs[name] = mergeProviderConfig(
      providers?.[name], defaults.cliPath, defaults.defaultModel,
    );
  }

  // config.yaml providers 섹션의 커스텀 프로바이더 (빌트인 아닌 것)
  if (providers) {
    for (const [name, raw] of Object.entries(providers)) {
      if (name in BUILTIN_DEFAULTS) continue;
      providerConfigs[name] = mergeProviderConfig(raw, name, '');
    }
  }

  // perProvider rate limits: 빌트인 + 커스텀 모두 동적으로 구성
  const perProviderConfig: Record<string, { rpm: number }> = {};
  for (const name of Object.keys(providerConfigs)) {
    perProviderConfig[name] = { rpm: perProvider?.[name]?.rpm ?? 20 };
  }

  // 플러그인 엔트리 파싱
  const plugins: PluginEntry[] = (rawPlugins ?? []).map((p) => ({
    path: p.path,
    config: p.config as Partial<ProviderConfigYaml> | undefined,
  }));

  return {
    server: {
      port: server?.port ?? DEFAULT_SERVER_PORT,
      host: server?.host ?? DEFAULT_HOST,
      cors: {
        origins: server?.cors?.origins ?? [`http://localhost:${DEFAULT_DASHBOARD_PORT}`],
      },
    },
    dashboard: {
      port: dashboard?.port ?? DEFAULT_DASHBOARD_PORT,
      host: dashboard?.host ?? DEFAULT_HOST,
    },
    database: {
      // DB 경로를 config.yaml이 있는 디렉토리 기준으로 해석
      path: resolve(dirname(resolvedPath), database?.path ?? './data/cliproxy.db'),
    },
    auth: {
      enabled: auth?.enabled ?? true,
      adminToken: auth?.admin_token ?? process.env.ADMIN_TOKEN ?? '',
      initialKeys: initialKeys.map((k) => ({
        name: k.name ?? 'default',
        key: k.key ?? process.env.PROXY_API_KEY ?? '',
      })),
    },
    providers: providerConfigs,
    plugins,
    rateLimits: {
      global: {
        rpm: globalLimits?.rpm ?? DEFAULT_RATE_LIMIT_RPM,
        rpd: globalLimits?.rpd ?? DEFAULT_RATE_LIMIT_RPD,
      },
      perProvider: perProviderConfig,
    },
    cache: {
      enabled: cache?.enabled ?? true,
      ttlSeconds: cache?.ttl_seconds ?? DEFAULT_CACHE_TTL_SECONDS,
      maxEntries: cache?.max_entries ?? DEFAULT_CACHE_MAX_ENTRIES,
    },
    validation: {
      maxMessageCount: validation?.max_message_count ?? DEFAULT_MAX_MESSAGE_COUNT,
      maxMessageLength: validation?.max_message_length ?? DEFAULT_MAX_MESSAGE_LENGTH,
      maxPromptLength: validation?.max_prompt_length ?? DEFAULT_MAX_PROMPT_LENGTH,
      maxResponseLength: validation?.max_response_length ?? DEFAULT_MAX_RESPONSE_LENGTH,
      bodyLimitBytes: validation?.body_limit_bytes ?? DEFAULT_BODY_LIMIT_BYTES,
    },
    modelMappings: modelMappings?.map((m) => ({
      alias: m.alias,
      provider: m.provider,
      actual_model: m.actual_model ?? '',
      reasoning_effort: normalizeReasoningEffort(m.reasoning_effort),
      provider_overrides: normalizeProviderOverrides(m.provider_overrides),
    })) ?? [
      // 초기 시드 — 프로바이더당 최대 2개. 대시보드에서 추가/수정 가능.
      { alias: 'claude-sonnet', provider: 'claude', actual_model: 'claude-sonnet-4-6' },
      { alias: 'claude-haiku', provider: 'claude', actual_model: 'claude-haiku-4-5-20251001' },
      { alias: 'gpt-5.5', provider: 'codex', actual_model: 'gpt-5.5' },
      { alias: 'gpt-5.4-mini', provider: 'codex', actual_model: 'gpt-5.4-mini' },
      { alias: 'copilot-sonnet', provider: 'copilot', actual_model: 'claude-sonnet-4-6' },
      { alias: 'copilot-gpt', provider: 'copilot', actual_model: 'gpt-5.4' },
      { alias: 'gemini-pro', provider: 'gemini', actual_model: 'gemini-2.5-pro' },
      { alias: 'gemini-flash', provider: 'gemini', actual_model: 'gemini-2.5-flash' },
      // Antigravity 1.0.0: actual_model은 표시용
      { alias: 'antigravity', provider: 'agy', actual_model: 'antigravity' },
      // xAI Grok Build — 최신 단일 모델
      { alias: 'grok-build', provider: 'grok', actual_model: 'grok-build' },
    ],
  };
}

function mergeProviderConfig(
  raw: RawProviderConfig | undefined,
  cliPath: string,
  defaultModel: string,
): ProviderConfigYaml {
  const defaults = defaultProviderConfig(cliPath, defaultModel);
  if (!raw) return defaults;

  // App Server 옵션: transport만 기본값 주입 (나머지는 스키마 검증된 값 그대로)
  const appServerOptions = raw.app_server_options
    ? { ...raw.app_server_options, transport: raw.app_server_options.transport ?? 'stdio' as const }
    : undefined;

  return {
    enabled: raw.enabled ?? defaults.enabled,
    cli_path: raw.cli_path ?? defaults.cli_path,
    default_model: raw.default_model ?? defaults.default_model,
    max_concurrent: raw.max_concurrent ?? defaults.max_concurrent,
    timeout_ms: raw.timeout_ms ?? defaults.timeout_ms,
    extra_args: raw.extra_args ?? defaults.extra_args,
    working_dir: raw.working_dir ?? undefined,
    mode: raw.mode ?? undefined,
    sdk_options: raw.sdk_options,
    app_server_options: appServerOptions,
    cli_options: raw.cli_options,
  };
}
