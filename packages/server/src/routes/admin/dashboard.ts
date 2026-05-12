import type { FastifyInstance } from 'fastify';
import { sql, eq, desc } from 'drizzle-orm';
import { getDatabase } from '../../db/client.js';
import { requestLogs, apiKeys, modelMappings, providerHealth, responseCache, settings } from '../../db/schema.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { QueueManager } from '../../services/queue.js';
import type { ActiveRequestTracker } from '../../services/active-requests.js';

interface DashboardDeps {
  registry: ProviderRegistry;
  queueManager: QueueManager;
  activeRequests: ActiveRequestTracker;
}

export function registerDashboardRoute(app: FastifyInstance, deps: DashboardDeps): void {
  app.get<{ Querystring: { days?: string } }>('/admin/dashboard', async (request, reply) => {
    const db = getDatabase();

    // 기간 필터 (days 파라미터, 0이면 전체)
    const days = parseInt(request.query.days ?? '0', 10);
    const dateFilter = days > 0
      ? sql`created_at >= datetime('now', '-${sql.raw(String(days))} days')`
      : undefined;

    // 1. 요약 통계
    const statsQuery = db.select({
      totalRequests: sql<number>`count(*)`,
      successCount: sql<number>`coalesce(sum(case when status = 'success' then 1 else 0 end), 0)`,
      errorCount: sql<number>`coalesce(sum(case when status = 'error' then 1 else 0 end), 0)`,
      timeoutCount: sql<number>`coalesce(sum(case when status = 'timeout' then 1 else 0 end), 0)`,
      avgLatencyMs: sql<number>`coalesce(avg(case when status = 'success' then latency_ms end), 0)`,
      totalPromptTokens: sql<number>`coalesce(sum(prompt_tokens), 0)`,
      totalCompletionTokens: sql<number>`coalesce(sum(completion_tokens), 0)`,
      totalTokens: sql<number>`coalesce(sum(total_tokens), 0)`,
      streamCount: sql<number>`coalesce(sum(case when is_stream = 1 then 1 else 0 end), 0)`,
    }).from(requestLogs);
    const statsResult = dateFilter ? await statsQuery.where(dateFilter) : await statsQuery;
    const overview = statsResult[0];

    // 2. 오늘 통계
    const todayResult = await db.select({
      count: sql<number>`count(*)`,
      successCount: sql<number>`coalesce(sum(case when status = 'success' then 1 else 0 end), 0)`,
      avgLatencyMs: sql<number>`coalesce(avg(case when status = 'success' then latency_ms end), 0)`,
    }).from(requestLogs)
      .where(sql`date(created_at) = date('now')`);
    const today = todayResult[0];

    // 3. 활성 API 키 수
    const keyCountResult = await db.select({
      total: sql<number>`count(*)`,
      active: sql<number>`sum(case when enabled = 1 then 1 else 0 end)`,
    }).from(apiKeys);
    const keyCount = keyCountResult[0];

    // 4. 모델 매핑 수
    const mappingCountResult = await db.select({
      total: sql<number>`count(*)`,
      active: sql<number>`sum(case when enabled = 1 then 1 else 0 end)`,
    }).from(modelMappings);
    const mappingCount = mappingCountResult[0];

    // 5. Provider 상태
    const healthData = await db.select().from(providerHealth);
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
    const cacheResult = await db.select({
      totalEntries: sql<number>`count(*)`,
      activeEntries: sql<number>`sum(case when expires_at > datetime('now') then 1 else 0 end)`,
    }).from(responseCache);
    const cache = cacheResult[0];

    // 7. Rate Limit 설정
    const rateLimitResult = await db.select()
      .from(settings)
      .where(eq(settings.key, 'rate_limits'));
    let rateLimits = { global: { rpm: 60, rpd: 1000 }, perProvider: {} };
    if (rateLimitResult.length > 0) {
      try { rateLimits = JSON.parse(rateLimitResult[0].value); } catch {}
    }

    // 8. Provider별 통계
    const providerStatsQuery = db.select({
      provider: requestLogs.provider,
      count: sql<number>`count(*)`,
      successCount: sql<number>`coalesce(sum(case when status = 'success' then 1 else 0 end), 0)`,
      avgLatencyMs: sql<number>`coalesce(avg(case when status = 'success' then latency_ms end), 0)`,
      totalTokens: sql<number>`coalesce(sum(total_tokens), 0)`,
    }).from(requestLogs);
    const providerStats = dateFilter
      ? await providerStatsQuery.where(dateFilter).groupBy(requestLogs.provider)
      : await providerStatsQuery.groupBy(requestLogs.provider);

    // 9. 인기 모델 (상위 5개)
    const popularModelsQuery = db.select({
      modelAlias: requestLogs.modelAlias,
      provider: requestLogs.provider,
      count: sql<number>`count(*)`,
      avgLatencyMs: sql<number>`coalesce(avg(case when status = 'success' then latency_ms end), 0)`,
    }).from(requestLogs);
    const popularModels = dateFilter
      ? await popularModelsQuery.where(dateFilter).groupBy(requestLogs.modelAlias, requestLogs.provider).orderBy(sql`count(*) DESC`).limit(5)
      : await popularModelsQuery.groupBy(requestLogs.modelAlias, requestLogs.provider).orderBy(sql`count(*) DESC`).limit(5);

    // 10. 24시간 시간대별 요청 추이 (모델별 breakdown 포함)
    const hourlyTrend = await db.select({
      hour: sql<number>`cast(strftime('%H', created_at) as integer)`,
      count: sql<number>`count(*)`,
      successCount: sql<number>`coalesce(sum(case when status = 'success' then 1 else 0 end), 0)`,
      errorCount: sql<number>`coalesce(sum(case when status != 'success' then 1 else 0 end), 0)`,
    }).from(requestLogs)
      .where(sql`created_at >= datetime('now', '-24 hours')`)
      .groupBy(sql`strftime('%H', created_at)`)
      .orderBy(sql`strftime('%H', created_at) ASC`);

    // 10-1. 모델별 시간대 breakdown
    const hourlyByModel = await db.select({
      hour: sql<number>`cast(strftime('%H', created_at) as integer)`,
      modelAlias: requestLogs.modelAlias,
      count: sql<number>`count(*)`,
    }).from(requestLogs)
      .where(sql`created_at >= datetime('now', '-24 hours')`)
      .groupBy(sql`strftime('%H', created_at)`, requestLogs.modelAlias)
      .orderBy(sql`strftime('%H', created_at) ASC`);

    // 11. 최근 요청 (10건)
    const recentRequestsQuery = db.select({
      id: requestLogs.id,
      modelAlias: requestLogs.modelAlias,
      provider: requestLogs.provider,
      actualModel: requestLogs.actualModel,
      reasoningEffort: requestLogs.reasoningEffort,
      status: requestLogs.status,
      latencyMs: requestLogs.latencyMs,
      totalTokens: requestLogs.totalTokens,
      isStream: requestLogs.isStream,
      errorMessage: requestLogs.errorMessage,
      createdAt: requestLogs.createdAt,
    }).from(requestLogs);
    const recentRequests = dateFilter
      ? await recentRequestsQuery.where(dateFilter).orderBy(desc(requestLogs.createdAt)).limit(10)
      : await recentRequestsQuery.orderBy(desc(requestLogs.createdAt)).limit(10);

    // 12. 최근 에러 (5건)
    const recentErrorsQuery = db.select({
      id: requestLogs.id,
      modelAlias: requestLogs.modelAlias,
      provider: requestLogs.provider,
      reasoningEffort: requestLogs.reasoningEffort,
      status: requestLogs.status,
      errorMessage: requestLogs.errorMessage,
      latencyMs: requestLogs.latencyMs,
      createdAt: requestLogs.createdAt,
    }).from(requestLogs);
    const recentErrors = dateFilter
      ? await recentErrorsQuery.where(sql`status != 'success' AND ${dateFilter}`).orderBy(desc(requestLogs.createdAt)).limit(5)
      : await recentErrorsQuery.where(sql`status != 'success'`).orderBy(desc(requestLogs.createdAt)).limit(5);

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
      hourlyTrend,
      hourlyByModel,
      recentRequests,
      recentErrors,
      activeRequests: {
        count: deps.activeRequests.count(),
        requests: deps.activeRequests.getAll(),
      },
    });
  });
}
