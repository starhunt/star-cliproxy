import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { AppConfig } from '@star-cliproxy/shared';
import { initDatabase } from './db/client.js';
import { createProviderRegistry } from './providers/provider-registry.js';
import { ModelRouter } from './services/router.js';
import { QueueManager } from './services/queue.js';
import { RateLimiter } from './middleware/rate-limiter.js';
import { HealthChecker } from './services/health-checker.js';
import { authMiddleware, adminAuthMiddleware } from './middleware/auth.js';
import { registerChatCompletionsRoute } from './routes/v1/chat-completions.js';
import { registerModelsRoute } from './routes/v1/models.js';
import { registerModelMappingsRoutes } from './routes/admin/model-mappings.js';
import { registerApiKeysRoutes } from './routes/admin/api-keys.js';
import { registerStatsRoutes } from './routes/admin/stats.js';
import { registerProvidersRoutes } from './routes/admin/providers.js';
import { registerTestModelRoute } from './routes/admin/test-model.js';
import { registerRateLimitsRoutes, loadRateLimitsFromDb } from './routes/admin/rate-limits.js';
import { registerDashboardRoute } from './routes/admin/dashboard.js';
import { ActiveRequestTracker } from './services/active-requests.js';
import { ResponseCache } from './services/cache.js';
import { DebugService } from './services/debug.js';
import { registerDebugRoutes } from './routes/admin/debug.js';
import { seedDatabase } from './db/seed.js';

export async function createApp(config: AppConfig) {
  // admin token 검증 (빈 토큰으로 시작 방지)
  if (config.auth.enabled && !config.auth.adminToken) {
    throw new Error('ADMIN_TOKEN must be set when auth is enabled. Set it in .env or config.yaml.');
  }

  // DB 초기화
  initDatabase(config.database.path);

  // 시드 데이터 (초기 API 키, 모델 매핑)
  await seedDatabase(config);

  // Provider 레지스트리
  const registry = createProviderRegistry(config.providers);

  // DB에서 저장된 Rate Limits 로드 (없으면 config.yaml 기본값 사용)
  const savedRateLimits = await loadRateLimitsFromDb(config.rateLimits);

  // 서비스
  const router = new ModelRouter(registry);
  const queueManager = new QueueManager();
  const rateLimiter = new RateLimiter(savedRateLimits);
  const healthChecker = new HealthChecker(registry);
  const activeRequests = new ActiveRequestTracker();
  const cache = new ResponseCache(config.cache);
  const debug = new DebugService();

  // Provider별 큐 설정
  for (const [name, providerConfig] of Object.entries(config.providers)) {
    if (providerConfig.enabled) {
      queueManager.addQueue(name as 'claude' | 'codex' | 'gemini', providerConfig.max_concurrent);
    }
  }

  // Fastify 앱
  const app = Fastify({
    bodyLimit: config.validation.bodyLimitBytes,
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    },
  });

  // CORS
  await app.register(cors, {
    origin: config.server.cors.origins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // Health check (인증 불필요)
  app.get('/health', async (_request, reply) => {
    return reply.send({
      status: 'ok',
      timestamp: new Date().toISOString(),
      providers: registry.getAll().map((p) => p.name),
    });
  });

  // OpenAI-compatible 라우트 (인증 필요)
  if (config.auth.enabled) {
    app.addHook('onRequest', async (request, reply) => {
      // /health와 /admin은 제외
      if (request.url === '/health' || request.url.startsWith('/admin')) return;
      await authMiddleware(request, reply);
    });
  }

  // Admin 라우트 (별도 인증)
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/admin')) return;
    await adminAuthMiddleware(request, reply, config.auth.adminToken);
  });

  // v1 라우트 등록
  registerChatCompletionsRoute(app, {
    router,
    queue: queueManager,
    rateLimiter,
    registry,
    healthChecker,
    validation: config.validation,
    activeRequests,
    cache,
    debug,
  });
  registerModelsRoute(app);

  // Admin 라우트 등록
  registerModelMappingsRoutes(app);
  registerApiKeysRoutes(app);
  registerStatsRoutes(app);
  registerProvidersRoutes(app, {
    registry,
    healthChecker,
    queueManager,
  });
  registerTestModelRoute(app, registry);
  registerRateLimitsRoutes(app, rateLimiter, config.rateLimits);
  registerDebugRoutes(app, debug);
  registerDashboardRoute(app, { registry, queueManager, activeRequests });

  // 활성 요청 API
  app.get('/admin/active-requests', async (_request, reply) => {
    return reply.send({
      count: activeRequests.count(),
      requests: activeRequests.getAll(),
    });
  });

  // 건강 체크 시작
  healthChecker.start(60_000);

  // 만료 캐시 정리 주기: 5분 간격
  const cacheCleanupTimer = setInterval(async () => {
    const deleted = await cache.cleanup();
    if (deleted > 0) {
      app.log.info(`Cache cleanup: ${deleted} expired entries removed`);
    }
  }, 5 * 60 * 1000);

  // 종료 처리
  app.addHook('onClose', async () => {
    healthChecker.stop();
    await rateLimiter.destroy();
    clearInterval(cacheCleanupTimer);
  });

  return app;
}
