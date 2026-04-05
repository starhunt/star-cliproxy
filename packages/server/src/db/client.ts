import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let client: Client | null = null;

export async function initDatabase(dbPath: string) {
  mkdirSync(dirname(dbPath), { recursive: true });

  client = createClient({ url: `file:${dbPath}` });

  // PRAGMA 설정
  await client.execute('PRAGMA journal_mode = WAL');
  await client.execute('PRAGMA foreign_keys = ON');

  db = drizzle(client, { schema });

  await createTables(client);

  return db;
}

async function createTables(client: Client) {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      rate_limit_rpm INTEGER,
      rate_limit_rpd INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS model_mappings (
      id TEXT PRIMARY KEY,
      alias TEXT NOT NULL,
      provider TEXT NOT NULL,
      actual_model TEXT NOT NULL,
      display_name TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS request_logs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      api_key_id TEXT REFERENCES api_keys(id),
      model_alias TEXT NOT NULL,
      provider TEXT NOT NULL,
      actual_model TEXT NOT NULL,
      status TEXT NOT NULL,
      status_code INTEGER,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      latency_ms INTEGER,
      ttfb_ms INTEGER,
      is_stream INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      request_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS response_cache (
      request_hash TEXT PRIMARY KEY,
      model_alias TEXT NOT NULL,
      provider TEXT NOT NULL,
      response_body TEXT NOT NULL,
      token_count INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_health (
      provider TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_check_at TEXT,
      last_success_at TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS debug_logs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      model_alias TEXT NOT NULL,
      provider TEXT NOT NULL,
      actual_model TEXT NOT NULL,
      is_stream INTEGER NOT NULL DEFAULT 0,
      cli_args TEXT,
      request_messages TEXT,
      raw_stdout TEXT,
      raw_stderr TEXT,
      http_request TEXT,
      http_response TEXT,
      http_stream_lines TEXT,
      raw_response_text TEXT,
      parsed_content TEXT,
      token_usage TEXT,
      status TEXT NOT NULL,
      latency_ms INTEGER,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_debug_logs_created_at ON debug_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_debug_logs_model ON debug_logs(model_alias);
    CREATE INDEX IF NOT EXISTS idx_logs_created_at ON request_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_logs_provider ON request_logs(provider);
    CREATE INDEX IF NOT EXISTS idx_logs_status ON request_logs(status);
    CREATE INDEX IF NOT EXISTS idx_mappings_alias ON model_mappings(alias);
    CREATE INDEX IF NOT EXISTS idx_cache_expires ON response_cache(expires_at);
  `);

  // 기존 DB 마이그레이션: debug_logs에 컬럼 추가 (이미 존재하면 무시)
  const httpColumns = ['http_request', 'http_response', 'http_stream_lines', 'raw_response_text'];
  for (const col of httpColumns) {
    try {
      await client.execute(`ALTER TABLE debug_logs ADD COLUMN ${col} TEXT`);
    } catch {
      // 이미 존재하면 무시
    }
  }
}

export function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export function closeDatabase() {
  if (client) {
    client.close();
    client = null;
    db = null;
  }
}
