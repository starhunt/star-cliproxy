import { nanoid } from 'nanoid';
import type { ReasoningEffort } from '@star-cliproxy/shared';
import { getDatabase } from '../db/client.js';
import { requestLogs } from '../db/schema.js';

export interface LogEntry {
  requestId: string;
  apiKeyId?: string;
  modelAlias: string;
  provider: string;
  actualModel: string;
  reasoningEffort?: ReasoningEffort;
  status: 'success' | 'error' | 'timeout' | 'cancelled';
  statusCode: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs: number;
  ttfbMs?: number;
  isStream: boolean;
  errorMessage?: string;
  requestHash?: string;
}

export async function logRequest(entry: LogEntry): Promise<void> {
  try {
    const db = getDatabase();
    await db.insert(requestLogs).values({
      id: nanoid(),
      createdAt: new Date().toISOString(),
      requestId: entry.requestId,
      apiKeyId: entry.apiKeyId,
      modelAlias: entry.modelAlias,
      provider: entry.provider,
      actualModel: entry.actualModel,
      reasoningEffort: entry.reasoningEffort ?? null,
      status: entry.status,
      statusCode: entry.statusCode,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      totalTokens: entry.totalTokens,
      latencyMs: entry.latencyMs,
      ttfbMs: entry.ttfbMs,
      isStream: entry.isStream,
      errorMessage: entry.errorMessage,
      requestHash: entry.requestHash,
    });
  } catch (err) {
    // 로깅 실패가 요청을 중단시키지 않도록
    console.error('Failed to log request:', err);
  }
}
