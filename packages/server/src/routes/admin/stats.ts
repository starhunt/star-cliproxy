import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { getDatabase } from '../../db/client.js';
import { requestLogs } from '../../db/schema.js';

export function registerStatsRoutes(app: FastifyInstance): void {
  // 전체 통계
  app.get('/admin/stats', async (_request, reply) => {
    const db = getDatabase();

    const totalResult = db.select({
      totalRequests: sql<number>`count(*)`,
      successCount: sql<number>`sum(case when status = 'success' then 1 else 0 end)`,
      errorCount: sql<number>`sum(case when status = 'error' then 1 else 0 end)`,
      avgLatencyMs: sql<number>`avg(latency_ms)`,
      totalPromptTokens: sql<number>`sum(prompt_tokens)`,
      totalCompletionTokens: sql<number>`sum(completion_tokens)`,
    }).from(requestLogs).all();

    const stats = totalResult[0] ?? {
      totalRequests: 0,
      successCount: 0,
      errorCount: 0,
      avgLatencyMs: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    };

    // Provider별 통계
    const providerStats = db.select({
      provider: requestLogs.provider,
      count: sql<number>`count(*)`,
      successCount: sql<number>`sum(case when status = 'success' then 1 else 0 end)`,
      avgLatencyMs: sql<number>`avg(latency_ms)`,
    }).from(requestLogs)
      .groupBy(requestLogs.provider)
      .all();

    // 모델별 통계
    const modelStats = db.select({
      modelAlias: requestLogs.modelAlias,
      provider: requestLogs.provider,
      count: sql<number>`count(*)`,
    }).from(requestLogs)
      .groupBy(requestLogs.modelAlias, requestLogs.provider)
      .all();

    return reply.send({
      overview: {
        totalRequests: stats.totalRequests ?? 0,
        successRate: stats.totalRequests
          ? ((stats.successCount ?? 0) / stats.totalRequests * 100).toFixed(1)
          : '0.0',
        avgLatencyMs: Math.round(stats.avgLatencyMs ?? 0),
        totalTokens: (stats.totalPromptTokens ?? 0) + (stats.totalCompletionTokens ?? 0),
      },
      byProvider: providerStats,
      byModel: modelStats,
    });
  });

  // 최근 요청 로그
  app.get<{ Querystring: { limit?: string; offset?: string; provider?: string; status?: string } }>(
    '/admin/logs',
    async (request, reply) => {
      const db = getDatabase();
      const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200);
      const offset = parseInt(request.query.offset ?? '0', 10);

      let query = db.select({
        id: requestLogs.id,
        requestId: requestLogs.requestId,
        modelAlias: requestLogs.modelAlias,
        provider: requestLogs.provider,
        actualModel: requestLogs.actualModel,
        status: requestLogs.status,
        latencyMs: requestLogs.latencyMs,
        ttfbMs: requestLogs.ttfbMs,
        isStream: requestLogs.isStream,
        totalTokens: requestLogs.totalTokens,
        errorMessage: requestLogs.errorMessage,
        createdAt: requestLogs.createdAt,
      }).from(requestLogs)
        .orderBy(sql`created_at DESC`)
        .limit(limit)
        .offset(offset);

      const logs = query.all();

      return reply.send({
        data: logs,
        pagination: { limit, offset },
      });
    },
  );
}
