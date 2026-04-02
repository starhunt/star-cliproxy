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
  isStream: integer('is_stream', { mode: 'boolean' }).notNull().default(false),
  cliArgs: text('cli_args'),
  requestMessages: text('request_messages'),
  rawStdout: text('raw_stdout'),
  rawStderr: text('raw_stderr'),
  httpRequest: text('http_request'),
  httpResponse: text('http_response'),
  httpStreamLines: text('http_stream_lines'),
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
