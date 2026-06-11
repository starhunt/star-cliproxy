import { nanoid } from 'nanoid';
import { and, desc, eq, like, lt, or, sql } from 'drizzle-orm';
import { getDatabase } from '../db/client.js';
import { debugLogs } from '../db/schema.js';

// 디버그 페이로드 최대 크기 (10KB)
const MAX_FIELD_LENGTH = 10_000;
// 디버그 로그 보존 기간(일). 민감 데이터(프롬프트/응답)가 무기한 저장되지 않도록 제한.
const DEBUG_LOG_RETENTION_DAYS = 14;
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // 프록시 자체 키 (구체 패턴 먼저)
  [/\bsk-proxy-[a-zA-Z0-9]+\b/g, 'sk-proxy-[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._\-]+\b/g, 'Bearer [redacted]'],
  [/"x-admin-token"\s*:\s*"[^"]+"/gi, '"x-admin-token":"[redacted]"'],
  [/"authorization"\s*:\s*"[^"]+"/gi, '"authorization":"[redacted]"'],
  [/([A-Z_]*(TOKEN|KEY|SECRET)[A-Z_]*=)[^\s"']+/g, '$1[redacted]'],
  // 서드파티 키 형식 (프롬프트/응답 본문에 포함될 수 있는 백엔드 키)
  [/\bsk-[a-zA-Z0-9_-]{20,}\b/g, 'sk-[redacted]'],          // OpenAI/Anthropic (sk-, sk-ant-, sk-proj-)
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[redacted]'],               // AWS access key id
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'AIza[redacted]'],          // Google API key
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, 'gh_[redacted]'],      // GitHub token
  [/\bxai-[A-Za-z0-9]{20,}\b/g, 'xai-[redacted]'],           // xAI key
];

// 테스트 가능하도록 export. 디버그 로그 저장 시 시크릿 마스킹에 사용.
export function redactSecrets(value: string): string {
  let redacted = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function truncate(value: string | undefined, max = MAX_FIELD_LENGTH): string | undefined {
  if (!value) return undefined;
  const redacted = redactSecrets(value);
  if (redacted.length <= max) return redacted;
  return redacted.substring(0, max) + `\n...[truncated, ${redacted.length - max} chars omitted]`;
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
  reasoningEffort?: string;
  isStream: boolean;
  requestMessages?: unknown;
}

export interface DebugLogCompleteEntry {
  requestId: string;
  cliArgs?: string[];
  rawStdout?: string;
  rawStderr?: string;
  streamLines?: string[];
  // HTTP Provider 전용
  httpRequest?: { method: string; url: string; headers: Record<string, string>; body: unknown };
  httpResponse?: { status: number; headers: Record<string, string>; body?: unknown };
  httpStreamLines?: string[];
  rawResponseText?: string;
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
        reasoningEffort: entry.reasoningEffort ?? null,
        isStream: entry.isStream,
        requestMessages: entry.requestMessages
          ? truncate(JSON.stringify(entry.requestMessages))
          : undefined,
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      // 보존 기간 초과 로그 정리 (best-effort, 실패해도 요청 흐름에 영향 없음)
      await this.pruneExpiredLogs();
    } catch (err) {
      console.error('Failed to save debug log start:', err);
    }
    return id;
  }

  // 보존 기간(DEBUG_LOG_RETENTION_DAYS)을 초과한 디버그 로그 삭제.
  // 민감 데이터(프롬프트/응답)의 무기한 보관을 방지한다.
  private async pruneExpiredLogs(): Promise<void> {
    const cutoff = new Date(Date.now() - DEBUG_LOG_RETENTION_DAYS * 86_400_000).toISOString();
    const db = getDatabase();
    // createdAt은 ISO 8601 문자열이라 사전식 비교가 시간순 비교와 일치
    await db.delete(debugLogs).where(lt(debugLogs.createdAt, cutoff));
  }

  // 응답 완료 시 UPDATE
  async logComplete(id: string, entry: DebugLogCompleteEntry): Promise<void> {
    try {
      const db = getDatabase();

      const rawStdout = entry.rawStdout
        ?? (entry.streamLines ? entry.streamLines.join('\n') : undefined);

      await db.update(debugLogs).set({
        cliArgs: entry.cliArgs ? JSON.stringify(entry.cliArgs.map((arg) => redactSecrets(arg))) : undefined,
        rawStdout: truncate(rawStdout),
        rawStderr: truncate(entry.rawStderr),
        httpRequest: entry.httpRequest ? truncate(JSON.stringify(entry.httpRequest)) : undefined,
        httpResponse: entry.httpResponse ? truncate(JSON.stringify(entry.httpResponse)) : undefined,
        httpStreamLines: entry.httpStreamLines ? truncate(entry.httpStreamLines.join('\n')) : undefined,
        rawResponseText: truncate(entry.rawResponseText),
        parsedContent: truncate(entry.parsedContent),
        tokenUsage: entry.tokenUsage ? JSON.stringify(entry.tokenUsage) : undefined,
        status: entry.status,
        latencyMs: entry.latencyMs,
        errorMessage: truncate(entry.errorMessage),
      }).where(eq(debugLogs.id, id));
    } catch (err) {
      console.error('Failed to update debug log:', err);
    }
  }

  private buildSearchCondition(search: string, scope: 'all' | 'request' | 'response') {
    const pattern = `%${search}%`;
    const requestFields = [
      like(debugLogs.requestMessages, pattern),
    ];
    const responseFields = [
      like(debugLogs.rawStdout, pattern),
      like(debugLogs.rawStderr, pattern),
      like(debugLogs.httpResponse, pattern),
      like(debugLogs.httpStreamLines, pattern),
      like(debugLogs.rawResponseText, pattern),
      like(debugLogs.parsedContent, pattern),
    ];

    if (scope === 'request') return or(...requestFields);
    if (scope === 'response') return or(...responseFields);
    return or(...requestFields, ...responseFields);
  }

  private buildWhereCondition(options?: { model?: string; search?: string; searchScope?: 'all' | 'request' | 'response' }) {
    const conditions = [];
    if (options?.model) {
      conditions.push(like(debugLogs.modelAlias, `%${options.model}%`));
    }
    if (options?.search) {
      const searchCond = this.buildSearchCondition(options.search, options.searchScope ?? 'all');
      if (searchCond) conditions.push(searchCond);
    }
    return conditions.length > 0 ? and(...conditions) : undefined;
  }

  async getLogs(options?: { limit?: number; offset?: number; model?: string; search?: string; searchScope?: 'all' | 'request' | 'response' }) {
    const db = getDatabase();
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const where = this.buildWhereCondition(options);

    const query = db.select().from(debugLogs);
    if (where) {
      return query.where(where).orderBy(desc(debugLogs.createdAt)).limit(limit).offset(offset);
    }
    return query.orderBy(desc(debugLogs.createdAt)).limit(limit).offset(offset);
  }

  // 총 건수 조회 (페이징용)
  async getLogCount(options?: { model?: string; search?: string; searchScope?: 'all' | 'request' | 'response' }): Promise<number> {
    const db = getDatabase();
    const where = this.buildWhereCondition(options);

    if (where) {
      const result = await db.select({ count: sql<number>`count(*)` }).from(debugLogs).where(where);
      return result[0]?.count ?? 0;
    }
    const result = await db.select({ count: sql<number>`count(*)` }).from(debugLogs);
    return result[0]?.count ?? 0;
  }

  // 복수 건 삭제
  async deleteLogs(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const db = getDatabase();
    let deleted = 0;
    for (const id of ids) {
      const result = await db.delete(debugLogs).where(eq(debugLogs.id, id));
      deleted += result.rowsAffected;
    }
    return deleted;
  }

  async deleteLog(id: string): Promise<boolean> {
    const db = getDatabase();
    const result = await db.delete(debugLogs).where(eq(debugLogs.id, id));
    return result.rowsAffected > 0;
  }

  async clearLogs(): Promise<number> {
    const db = getDatabase();
    const result = await db.delete(debugLogs);
    return result.rowsAffected;
  }
}
