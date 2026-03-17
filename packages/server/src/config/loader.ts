import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AppConfig, ProviderConfigYaml } from '@star-cliproxy/shared';
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
} from '@star-cliproxy/shared';

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

export function loadConfig(configPath?: string): AppConfig {
  const resolvedPath = configPath ?? resolve(process.cwd(), 'config.yaml');

  let rawConfig: Record<string, unknown> = {};

  if (existsSync(resolvedPath)) {
    const content = readFileSync(resolvedPath, 'utf-8');
    const substituted = substituteEnvVars(content);
    rawConfig = parseYaml(substituted) ?? {};
  }

  const server = rawConfig.server as Record<string, unknown> | undefined;
  const dashboard = rawConfig.dashboard as Record<string, unknown> | undefined;
  const database = rawConfig.database as Record<string, unknown> | undefined;
  const auth = rawConfig.auth as Record<string, unknown> | undefined;
  const providers = rawConfig.providers as Record<string, Record<string, unknown>> | undefined;
  const rateLimits = rawConfig.rate_limits as Record<string, unknown> | undefined;
  const cache = rawConfig.cache as Record<string, unknown> | undefined;
  const validation = rawConfig.validation as Record<string, unknown> | undefined;
  const modelMappings = rawConfig.model_mappings as Array<Record<string, string>> | undefined;

  const corsObj = server?.cors as Record<string, unknown> | undefined;
  const globalLimits = rateLimits?.global as Record<string, number> | undefined;
  const perProvider = rateLimits?.per_provider as Record<string, Record<string, number>> | undefined;

  const initialKeys = (auth?.initial_keys as Array<Record<string, string>> | undefined) ?? [];

  return {
    server: {
      port: (server?.port as number) ?? DEFAULT_SERVER_PORT,
      host: (server?.host as string) ?? DEFAULT_HOST,
      cors: {
        origins: (corsObj?.origins as string[]) ?? [`http://localhost:${DEFAULT_DASHBOARD_PORT}`],
      },
    },
    dashboard: {
      port: (dashboard?.port as number) ?? DEFAULT_DASHBOARD_PORT,
      host: (dashboard?.host as string) ?? DEFAULT_HOST,
    },
    database: {
      // DB 경로를 config.yaml이 있는 디렉토리 기준으로 해석
      path: resolve(dirname(resolvedPath), (database?.path as string) ?? './data/cliproxy.db'),
    },
    auth: {
      enabled: (auth?.enabled as boolean) ?? true,
      adminToken: (auth?.admin_token as string) ?? process.env.ADMIN_TOKEN ?? '',
      initialKeys: initialKeys.map((k) => ({
        name: k.name ?? 'default',
        key: k.key ?? process.env.PROXY_API_KEY ?? '',
      })),
    },
    providers: {
      claude: mergeProviderConfig(providers?.claude, 'claude', 'claude-sonnet-4-6'),
      codex: mergeProviderConfig(providers?.codex, 'codex', ''),
      gemini: mergeProviderConfig(providers?.gemini, 'gemini', 'gemini-2.5-pro'),
    },
    rateLimits: {
      global: {
        rpm: globalLimits?.rpm ?? DEFAULT_RATE_LIMIT_RPM,
        rpd: globalLimits?.rpd ?? DEFAULT_RATE_LIMIT_RPD,
      },
      perProvider: {
        claude: { rpm: perProvider?.claude?.rpm ?? 20 },
        codex: { rpm: perProvider?.codex?.rpm ?? 20 },
        gemini: { rpm: perProvider?.gemini?.rpm ?? 20 },
      },
    },
    cache: {
      enabled: (cache?.enabled as boolean) ?? true,
      ttlSeconds: (cache?.ttl_seconds as number) ?? DEFAULT_CACHE_TTL_SECONDS,
      maxEntries: (cache?.max_entries as number) ?? DEFAULT_CACHE_MAX_ENTRIES,
    },
    validation: {
      maxMessageCount: (validation?.max_message_count as number) ?? DEFAULT_MAX_MESSAGE_COUNT,
      maxMessageLength: (validation?.max_message_length as number) ?? DEFAULT_MAX_MESSAGE_LENGTH,
      maxPromptLength: (validation?.max_prompt_length as number) ?? DEFAULT_MAX_PROMPT_LENGTH,
      maxResponseLength: (validation?.max_response_length as number) ?? DEFAULT_MAX_RESPONSE_LENGTH,
      bodyLimitBytes: (validation?.body_limit_bytes as number) ?? DEFAULT_BODY_LIMIT_BYTES,
    },
    modelMappings: modelMappings?.map((m) => ({
      alias: m.alias,
      provider: m.provider as 'claude' | 'codex' | 'gemini',
      actual_model: m.actual_model,
    })) ?? [
      { alias: 'claude-opus', provider: 'claude', actual_model: 'claude-opus-4-6' },
      { alias: 'claude-sonnet', provider: 'claude', actual_model: 'claude-sonnet-4-6' },
      { alias: 'claude-haiku', provider: 'claude', actual_model: 'claude-haiku-4-5-20251001' },
      { alias: 'gpt-4', provider: 'codex', actual_model: '' },
      { alias: 'gpt-4o', provider: 'codex', actual_model: '' },
      { alias: 'o4-mini', provider: 'codex', actual_model: '' },
      { alias: 'gemini-pro', provider: 'gemini', actual_model: 'gemini-2.5-pro' },
      { alias: 'gemini-flash', provider: 'gemini', actual_model: 'gemini-2.5-flash' },
    ],
  };
}

function mergeProviderConfig(
  raw: Record<string, unknown> | undefined,
  cliPath: string,
  defaultModel: string,
): ProviderConfigYaml {
  const defaults = defaultProviderConfig(cliPath, defaultModel);
  if (!raw) return defaults;

  return {
    enabled: (raw.enabled as boolean) ?? defaults.enabled,
    cli_path: (raw.cli_path as string) ?? defaults.cli_path,
    default_model: (raw.default_model as string) ?? defaults.default_model,
    max_concurrent: (raw.max_concurrent as number) ?? defaults.max_concurrent,
    timeout_ms: (raw.timeout_ms as number) ?? defaults.timeout_ms,
    extra_args: (raw.extra_args as string[]) ?? defaults.extra_args,
  };
}
