import type { FastifyInstance } from 'fastify';
import { sql, eq, desc } from 'drizzle-orm';
import { getDatabase } from '../../db/client.js';
import { requestLogs, apiKeys, modelMappings, providerHealth, responseCache, settings } from '../../db/schema.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { QueueManager } from '../../services/queue.js';

interface DashboardDeps {
  registry: ProviderRegistry;
  queueManager: QueueManager;
}

export function registerDashboardRoute(app: FastifyInstance, deps: DashboardDeps): void {
  app.get('/admin/dashboard', async (_request, reply) => {
    const db = getDatabase();

    // 1. 요약 통계
    const statsResult = db.select({
      totalRequests: sql<number>`count(*)`,
      successCount: sql<number>`coalesce(sum(case when status = 'success' then 1 else 0 end), 0)`,
      errorCount: sql<number>`coalesce(sum(case when status = 'error' then 1 else 0 end), 0)`,
      timeoutCount: sql<number>`coalesce(sum(case when status = 'timeout' then 1 else 0 end), 0)`,
      avgLatencyMs: sql<number>`coalesce(avg(case when status = 'success' then latency_ms end), 0)`,
      totalPromptTokens: sql<number>`coalesce(sum(prompt_tokens), 0)`,
      totalCompletionTokens: sql<number>`coalesce(sum(completion_tokens), 0)`,
      totalTokens: sql<number>`coalesce(sum(total_tokens), 0)`,
      streamCount: sql<number>`coalesce(sum(case when is_stream = 1 then 1 else 0 end), 0)`,
    }).from(requestLogs).all();
    const overview = statsResult[0];

    // 2. 오늘 통계
    const todayResult = db.select({
      count: sql<number>`count(*)`,
      successCount: sql<number>`coalesce(sum(case when status = 'success' then 1 else 0 end), 0)`,
      avgLatencyMs: sql<number>`coalesce(avg(case when status = 'success' then latency_ms end), 0)`,
    }).from(requestLogs)
      .where(sql`date(created_at) = date('now')`)
      .all();
    const today = todayResult[0];

    // 3. 활성 API 키 수
    const keyCountResult = db.select({
      total: sql<number>`count(*)`,
      active: sql<number>`sum(case when enabled = 1 then 1 else 0 end)`,
    }).from(apiKeys).all();
    const keyCount = keyCountResult[0];

    // 4. 모델 매핑 수
    const mappingCountResult = db.select({
      total: sql<number>`count(*)`,
      active: sql<number>`sum(case when enabled = 1 then 1 else 0 end)`,
    }).from(modelMappings).all();
    const mappingCount = mappingCountResult[0];

    // 5. Provider 상태
    const healthData = db.select().from(providerHealth).all();
    const providers = deps.registry.getAll().map((p) => {
      const health = healthData.find((h) => h.provider === p.name);
      const queue = deps.queueManager.getStatus(p.name);
      return {
        name: p.name,
        status: health?.status ?? 'unknown',
        lastCheckAt: health?.lastCheckAt,
        consecutiveFailures: health?.consecutiveFailures ?? 0,
        queue,
      };
    });

    // 6. 캐시 통계
    const cacheResult = db.select({
      totalEntries: sql<number>`count(*)`,
      activeEntries: sql<number>`sum(case when expires_at > datetime('now') then 1 else 0 end)`,
    }).from(responseCache).all();
    const cache = cacheResult[0];

    // 7. Rate Limit 설정
    const rateLimitResult = db.select()
      .from(settings)
      .where(eq(settings.key, 'rate_limits'))
      .all();
    let rateLimits = { global: { rpm: 60, rpd: 1000 }, perProvider: {} };
    if (rateLimitResult.length > 0) {
      try { rateLimits = JSON.parse(rateLimitResult[0].value); } catch {}
    }

    // 8. Provider별 통계
    const providerStats = db.select({
      provider: requestLogs.provider,
      count: sql<number>`count(*)`,
      successCount: sql<number>`coalesce(sum(case when status = 'success' then 1 else 0 end), 0)`,
      avgLatencyMs: sql<number>`coalesce(avg(case when status = 'success' then latency_ms end), 0)`,
      totalTokens: sql<number>`coalesce(sum(total_tokens), 0)`,
    }).from(requestLogs)
      .groupBy(requestLogs.provider)
      .all();

    // 9. 인기 모델 (상위 5개)
    const popularModels = db.select({
      modelAlias: requestLogs.modelAlias,
      provider: requestLogs.provider,
      count: sql<number>`count(*)`,
      avgLatencyMs: sql<number>`coalesce(avg(case when status = 'success' then latency_ms end), 0)`,
    }).from(requestLogs)
      .groupBy(requestLogs.modelAlias, requestLogs.provider)
      .orderBy(sql`count(*) DESC`)
      .limit(5)
      .all();

    // 10. 일별 요청 추이 (최근 14일)
    const dailyTrend = db.select({
      date: sql<string>`date(created_at)`,
      count: sql<number>`count(*)`,
      successCount: sql<number>`coalesce(sum(case when status = 'success' then 1 else 0 end), 0)`,
      errorCount: sql<number>`coalesce(sum(case when status != 'success' then 1 else 0 end), 0)`,
    }).from(requestLogs)
      .where(sql`created_at >= datetime('now', '-14 days')`)
      .groupBy(sql`date(created_at)`)
      .orderBy(sql`date(created_at) ASC`)
      .all();

    // 11. 최근 요청 (5건)
    const recentRequests = db.select({
      id: requestLogs.id,
      modelAlias: requestLogs.modelAlias,
      provider: requestLogs.provider,
      actualModel: requestLogs.actualModel,
      status: requestLogs.status,
      latencyMs: requestLogs.latencyMs,
      totalTokens: requestLogs.totalTokens,
      isStream: requestLogs.isStream,
      createdAt: requestLogs.createdAt,
    }).from(requestLogs)
      .orderBy(desc(requestLogs.createdAt))
      .limit(5)
      .all();

    return reply.send({
      overview: {
        totalRequests: overview.totalRequests ?? 0,
        successCount: overview.successCount ?? 0,
        errorCount: overview.errorCount ?? 0,
        timeoutCount: overview.timeoutCount ?? 0,
        successRate: overview.totalRequests
          ? ((overview.successCount ?? 0) / overview.totalRequests * 100)
          : 0,
        avgLatencyMs: Math.round(overview.avgLatencyMs ?? 0),
        totalTokens: overview.totalTokens ?? 0,
        streamCount: overview.streamCount ?? 0,
      },
      today: {
        count: today.count ?? 0,
        successCount: today.successCount ?? 0,
        avgLatencyMs: Math.round(today.avgLatencyMs ?? 0),
      },
      apiKeys: {
        total: keyCount.total ?? 0,
        active: keyCount.active ?? 0,
      },
      modelMappings: {
        total: mappingCount.total ?? 0,
        active: mappingCount.active ?? 0,
      },
      providers,
      cache: {
        totalEntries: cache.totalEntries ?? 0,
        activeEntries: cache.activeEntries ?? 0,
      },
      rateLimits,
      providerStats,
      popularModels,
      dailyTrend,
      recentRequests,
    });
  });
}
