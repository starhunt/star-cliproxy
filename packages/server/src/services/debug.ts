import { nanoid } from 'nanoid';
import { desc, eq, like } from 'drizzle-orm';
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

export interface DebugLogEntry {
  requestId: string;
  modelAlias: string;
  provider: string;
  actualModel: string;
  isStream: boolean;
  cliArgs?: string[];
  requestMessages?: unknown;
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
    if (enabled) {
      this.config.models[alias] = true;
    } else {
      delete this.config.models[alias];
    }
  }

  isEnabled(modelAlias?: string): boolean {
    if (this.config.global) return true;
    if (modelAlias && this.config.models[modelAlias]) return true;
    return false;
  }

  async log(entry: DebugLogEntry): Promise<void> {
    try {
      const db = getDatabase();

      // streaming의 경우 streamLines를 stdout으로 합쳐서 저장
      const rawStdout = entry.rawStdout
        ?? (entry.streamLines ? entry.streamLines.join('\n') : undefined);

      await db.insert(debugLogs).values({
        id: nanoid(),
        requestId: entry.requestId,
        modelAlias: entry.modelAlias,
        provider: entry.provider,
        actualModel: entry.actualModel,
        isStream: entry.isStream,
        cliArgs: entry.cliArgs ? JSON.stringify(entry.cliArgs) : undefined,
        requestMessages: entry.requestMessages
          ? truncate(JSON.stringify(entry.requestMessages))
          : undefined,
        rawStdout: truncate(rawStdout),
        rawStderr: truncate(entry.rawStderr),
        parsedContent: truncate(entry.parsedContent),
        tokenUsage: entry.tokenUsage ? JSON.stringify(entry.tokenUsage) : undefined,
        status: entry.status,
        latencyMs: entry.latencyMs,
        errorMessage: entry.errorMessage,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      // 디버그 로깅 실패가 요청을 중단시키지 않도록
      console.error('Failed to save debug log:', err);
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

  async clearLogs(): Promise<number> {
    const db = getDatabase();
    const result = await db.delete(debugLogs);
    return result.changes;
  }
}
