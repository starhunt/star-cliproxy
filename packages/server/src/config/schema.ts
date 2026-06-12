// config.yaml raw 구조 Zod 스키마 (#30)
// YAML 파싱 직후의 snake_case 구조를 검증한다. 기본값 주입은 loader.ts가 담당.
//
// 설계 결정:
// - 모든 필드는 선택적(opt) — 누락 시 loader가 기본값 폴백 (기존 동작 유지)
// - null은 undefined와 동일 취급 — 빈 env var 치환(`port: ${PORT}` → `port:`)이 null이 되는 경우
// - 알 수 없는 키는 무시 (zod 기본 strip) — 전방 호환
// - model_mappings의 alias/provider만 필수 — 누락 시 런타임 오동작 대신 기동 거부
// - reasoning_effort / provider_overrides 값 정규화는 기존 normalize 함수가 담당 (silently-ignore 유지)

import { z } from 'zod';

// null → undefined 변환 포함 선택적 필드
const opt = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((v) => v ?? undefined);

const port = z.int().min(1).max(65535);
const positiveInt = z.int().positive();
const positiveNumber = z.number().positive();

const serverSchema = z.object({
  port: opt(port),
  host: opt(z.string()),
  cors: opt(
    z.object({
      origins: opt(z.array(z.string())),
    }),
  ),
});

const dashboardSchema = z.object({
  port: opt(port),
  host: opt(z.string()),
});

const databaseSchema = z.object({
  path: opt(z.string()),
});

const authSchema = z.object({
  enabled: opt(z.boolean()),
  admin_token: opt(z.string()),
  initial_keys: opt(
    z.array(
      z.object({
        name: opt(z.string()),
        key: opt(z.string()),
      }),
    ),
  ),
});

const sdkOptionsSchema = z.object({
  max_turns: opt(positiveInt),
  permission_mode: opt(z.string()),
  allowed_tools: opt(z.array(z.string())),
  disallowed_tools: opt(z.array(z.string())),
  max_budget_usd: opt(positiveNumber),
  session_ttl_ms: opt(positiveInt),
  enable_session_reuse: opt(z.boolean()),
  persist_session: opt(z.boolean()),
});

const appServerOptionsSchema = z.object({
  transport: opt(z.enum(['stdio', 'websocket'])),
  websocket_url: opt(z.string()),
  session_ttl_ms: opt(positiveInt),
  enable_session_reuse: opt(z.boolean()),
  max_turns: opt(positiveInt),
  auto_restart: opt(z.boolean()),
  max_restart_count: opt(positiveInt),
});

const cliOptionsSchema = z.object({
  ephemeral: opt(z.boolean()),
  enable_session_reuse: opt(z.boolean()),
  session_ttl_ms: opt(positiveInt),
});

const providerSchema = z.object({
  enabled: opt(z.boolean()),
  cli_path: opt(z.string()),
  default_model: opt(z.string()),
  max_concurrent: opt(positiveInt),
  timeout_ms: opt(positiveInt),
  extra_args: opt(z.array(z.string())),
  working_dir: opt(z.string()),
  mode: opt(z.enum(['cli', 'sdk', 'app-server'])),
  sdk_options: opt(sdkOptionsSchema),
  app_server_options: opt(appServerOptionsSchema),
  cli_options: opt(cliOptionsSchema),
});

const rateLimitsSchema = z.object({
  global: opt(
    z.object({
      rpm: opt(positiveInt),
      rpd: opt(positiveInt),
    }),
  ),
  per_provider: opt(z.record(z.string(), opt(z.object({ rpm: opt(positiveInt) })))),
});

const cacheSchema = z.object({
  enabled: opt(z.boolean()),
  ttl_seconds: opt(positiveInt),
  max_entries: opt(positiveInt),
});

const validationSchema = z.object({
  max_message_count: opt(positiveInt),
  max_message_length: opt(positiveInt),
  max_prompt_length: opt(positiveInt),
  max_response_length: opt(positiveInt),
  body_limit_bytes: opt(positiveInt),
});

const modelMappingSchema = z.object({
  alias: z.string().min(1),
  provider: z.string().min(1),
  actual_model: opt(z.string()),
  // 값 화이트리스트 검증은 normalizeReasoningEffort가 수행 (미지원 값 silently 무시)
  reasoning_effort: opt(z.string()),
  // 키 화이트리스트 정규화는 normalizeProviderOverrides가 수행 (비허용 키 silently 드롭)
  provider_overrides: z.unknown().optional(),
});

const pluginSchema = z.object({
  path: z.string().min(1),
  config: opt(providerSchema),
});

export const rawConfigSchema = z.object({
  server: opt(serverSchema),
  dashboard: opt(dashboardSchema),
  database: opt(databaseSchema),
  auth: opt(authSchema),
  providers: opt(z.record(z.string(), opt(providerSchema))),
  plugins: opt(z.array(pluginSchema)),
  rate_limits: opt(rateLimitsSchema),
  cache: opt(cacheSchema),
  validation: opt(validationSchema),
  model_mappings: opt(z.array(modelMappingSchema)),
});

export type RawConfig = z.infer<typeof rawConfigSchema>;
export type RawProviderConfig = z.infer<typeof providerSchema>;
