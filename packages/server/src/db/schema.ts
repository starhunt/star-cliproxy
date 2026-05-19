import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  keyHash: text('key_hash').notNull().unique(),
  keyPrefix: text('key_prefix').notNull(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  rateLimitRpm: integer('rate_limit_rpm'),
  rateLimitRpd: integer('rate_limit_rpd'),
  createdAt: text('created_at').notNull().default('(datetime(\'now\'))'),
  lastUsedAt: text('last_used_at'),
  expiresAt: text('expires_at'),
});

export const modelMappings = sqliteTable('model_mappings', {
  id: text('id').primaryKey(),
  alias: text('alias').notNull(),
  provider: text('provider').notNull(),
  actualModel: text('actual_model').notNull(),
  displayName: text('display_name'),
  reasoningEffort: text('reasoning_effort'),
  providerOverrides: text('provider_overrides'),  // JSON string, 화이트리스트 기반 옵션 오버라이드
  // 추론 노출 정책: NULL=상속(전역 default), 1=노출, 0=숨김.
  // body.include_reasoning > mapping.includeReasoning > 전역 default 순으로 적용.
  includeReasoning: integer('include_reasoning', { mode: 'boolean' }),
  // 백엔드 비표준 필드 패스스루 (JSON 객체). 예: {chat_template_kwargs:{enable_thinking:false}} (vLLM/sglang),
  // {think:false} (Ollama), {top_k:20, repetition_penalty:1.05} 등.
  // HTTP provider만 사용하고 CLI provider는 무시.
  extraBody: text('extra_body'),
  priority: integer('priority').notNull().default(0),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default('(datetime(\'now\'))'),
  updatedAt: text('updated_at').notNull().default('(datetime(\'now\'))'),
});

export const requestLogs = sqliteTable('request_logs', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull().unique(),
  apiKeyId: text('api_key_id').references(() => apiKeys.id),
  modelAlias: text('model_alias').notNull(),
  provider: text('provider').notNull(),
  actualModel: text('actual_model').notNull(),
  reasoningEffort: text('reasoning_effort'),
  status: text('status').notNull(),
  statusCode: integer('status_code'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  totalTokens: integer('total_tokens'),
  latencyMs: integer('latency_ms'),
  ttfbMs: integer('ttfb_ms'),
  isStream: integer('is_stream', { mode: 'boolean' }).notNull().default(false),
  errorMessage: text('error_message'),
  requestHash: text('request_hash'),
  createdAt: text('created_at').notNull().default('(datetime(\'now\'))'),
});

export const responseCache = sqliteTable('response_cache', {
  requestHash: text('request_hash').primaryKey(),
  modelAlias: text('model_alias').notNull(),
  provider: text('provider').notNull(),
  responseBody: text('response_body').notNull(),
  tokenCount: integer('token_count'),
  createdAt: text('created_at').notNull().default('(datetime(\'now\'))'),
  expiresAt: text('expires_at').notNull(),
});

export const providerHealth = sqliteTable('provider_health', {
  provider: text('provider').primaryKey(),
  status: text('status').notNull().default('unknown'),
  lastCheckAt: text('last_check_at'),
  lastSuccessAt: text('last_success_at'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  errorMessage: text('error_message'),
});

export const debugLogs = sqliteTable('debug_logs', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull(),
  modelAlias: text('model_alias').notNull(),
  provider: text('provider').notNull(),
  actualModel: text('actual_model').notNull(),
  reasoningEffort: text('reasoning_effort'),
  isStream: integer('is_stream', { mode: 'boolean' }).notNull().default(false),
  cliArgs: text('cli_args'),
  requestMessages: text('request_messages'),
  rawStdout: text('raw_stdout'),
  rawStderr: text('raw_stderr'),
  httpRequest: text('http_request'),
  httpResponse: text('http_response'),
  httpStreamLines: text('http_stream_lines'),
  rawResponseText: text('raw_response_text'),
  parsedContent: text('parsed_content'),
  tokenUsage: text('token_usage'),
  status: text('status').notNull(),
  latencyMs: integer('latency_ms'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull().default('(datetime(\'now\'))'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().default('(datetime(\'now\'))'),
});
