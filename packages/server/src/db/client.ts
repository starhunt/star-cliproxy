import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let sqlite: Database.Database | null = null;

export function initDatabase(dbPath: string) {
  mkdirSync(dirname(dbPath), { recursive: true });

  sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  db = drizzle(sqlite, { schema });

  createTables(sqlite);

  return db;
}

function createTables(sqlite: Database.Database) {
  sqlite.exec(`
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

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_logs_created_at ON request_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_logs_provider ON request_logs(provider);
    CREATE INDEX IF NOT EXISTS idx_logs_status ON request_logs(status);
    CREATE INDEX IF NOT EXISTS idx_mappings_alias ON model_mappings(alias);
    CREATE INDEX IF NOT EXISTS idx_cache_expires ON response_cache(expires_at);
  `);
}

export function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export function closeDatabase() {
  if (sqlite) {
    sqlite.close();
    sqlite = null;
    db = null;
  }
}
