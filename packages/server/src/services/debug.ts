import { nanoid } from 'nanoid';
import { desc, eq, like, sql } from 'drizzle-orm';
import { getDatabase } from '../db/client.js';
import { debugLogs } from '../db/schema.js';

// 디버그 페이로드 최대 크기 (10KB)
const MAX_FIELD_LENGTH = 10_000;

function truncate(value: string | undefined, max = MAX_FIELD_LENGTH): string | undefined {
  if (!value) return undefined;
  if (value.length <= max) return value;
  return value.substring(0, max) + `\n...[truncated, ${value.length - max} chars omitted]`;
}

export interface DebugConfig {
  global: boolean;
  models: Record<string, boolean>;
}

export interface DebugLogStartEntry {
  requestId: string;
  modelAlias: string;
  provider: string;
  actualModel: string;
  isStream: boolean;
  requestMessages?: unknown;
}

export interface DebugLogCompleteEntry {
  requestId: string;
  cliArgs?: string[];
  rawStdout?: string;
  rawStderr?: string;
  streamLines?: string[];
  parsedContent?: string;
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  status: 'success' | 'error' | 'timeout';
  latencyMs: number;
  errorMessage?: string;
}

export class DebugService {
  private config: DebugConfig = { global: false, models: {} };

  getConfig(): DebugConfig {
    return { ...this.config, models: { ...this.config.models } };
  }

  setGlobal(enabled: boolean): void {
    this.config.global = enabled;
  }

  setModel(alias: string, enabled: boolean): void {
    const key = alias.trim();
    if (enabled) {
      this.config.models[key] = true;
    } else {
      delete this.config.models[key];
    }
  }

  isEnabled(modelAlias?: string): boolean {
    if (this.config.global) return true;
    if (modelAlias && this.config.models[modelAlias]) return true;
    return false;
  }

  // 요청 시작 시 즉시 INSERT (status: pending)
  async logStart(entry: DebugLogStartEntry): Promise<string> {
    const id = nanoid();
    try {
      const db = getDatabase();
      await db.insert(debugLogs).values({
        id,
        requestId: entry.requestId,
        modelAlias: entry.modelAlias,
        provider: entry.provider,
        actualModel: entry.actualModel,
        isStream: entry.isStream,
        requestMessages: entry.requestMessages
          ? truncate(JSON.stringify(entry.requestMessages))
          : undefined,
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('Failed to save debug log start:', err);
    }
    return id;
  }

  // 응답 완료 시 UPDATE
  async logComplete(id: string, entry: DebugLogCompleteEntry): Promise<void> {
    try {
      const db = getDatabase();

      const rawStdout = entry.rawStdout
        ?? (entry.streamLines ? entry.streamLines.join('\n') : undefined);

      await db.update(debugLogs).set({
        cliArgs: entry.cliArgs ? JSON.stringify(entry.cliArgs) : undefined,
        rawStdout: truncate(rawStdout),
        rawStderr: truncate(entry.rawStderr),
        parsedContent: truncate(entry.parsedContent),
        tokenUsage: entry.tokenUsage ? JSON.stringify(entry.tokenUsage) : undefined,
        status: entry.status,
        latencyMs: entry.latencyMs,
        errorMessage: entry.errorMessage,
      }).where(eq(debugLogs.id, id));
    } catch (err) {
      console.error('Failed to update debug log:', err);
    }
  }

  async getLogs(options?: { limit?: number; offset?: number; model?: string }) {
    const db = getDatabase();
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    if (options?.model) {
      return db.select().from(debugLogs)
        .where(like(debugLogs.modelAlias, `%${options.model}%`))
        .orderBy(desc(debugLogs.createdAt))
        .limit(limit).offset(offset);
    }

    return db.select().from(debugLogs)
      .orderBy(desc(debugLogs.createdAt))
      .limit(limit).offset(offset);
  }

  // 총 건수 조회 (페이징용)
  async getLogCount(model?: string): Promise<number> {
    const db = getDatabase();
    if (model) {
      const result = db.select({ count: sql<number>`count(*)` }).from(debugLogs)
        .where(like(debugLogs.modelAlias, `%${model}%`)).all();
      return result[0]?.count ?? 0;
    }
    const result = db.select({ count: sql<number>`count(*)` }).from(debugLogs).all();
    return result[0]?.count ?? 0;
  }

  // 복수 건 삭제
  async deleteLogs(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const db = getDatabase();
    let deleted = 0;
    for (const id of ids) {
      const result = await db.delete(debugLogs).where(eq(debugLogs.id, id));
      deleted += result.changes;
    }
    return deleted;
  }

  async deleteLog(id: string): Promise<boolean> {
    const db = getDatabase();
    const result = await db.delete(debugLogs).where(eq(debugLogs.id, id));
    return result.changes > 0;
  }

  async clearLogs(): Promise<number> {
    const db = getDatabase();
    const result = await db.delete(debugLogs);
    return result.changes;
  }
}
