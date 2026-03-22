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
import { registerMessagesRoute } from './routes/v1/messages.js';
import { registerModelsRoute } from './routes/v1/models.js';
import { registerImageGenerationsRoute } from './routes/v1/images-generations.js';
import { registerModelMappingsRoutes } from './routes/admin/model-mappings.js';
import { registerApiKeysRoutes } from './routes/admin/api-keys.js';
import { registerStatsRoutes } from './routes/admin/stats.js';
import { registerProvidersRoutes } from './routes/admin/providers.js';
import { registerTestModelRoute } from './routes/admin/test-model.js';
import { registerRateLimitsRoutes, loadRateLimitsFromDb } from './routes/admin/rate-limits.js';
import { loadProviderConfigFromDb } from './routes/admin/providers.js';
import { registerDashboardRoute } from './routes/admin/dashboard.js';
import { ActiveRequestTracker } from './services/active-requests.js';
import { ResponseCache } from './services/cache.js';
import { DebugService } from './services/debug.js';
import { registerDebugRoutes } from './routes/admin/debug.js';
import { registerSettingsRoutes, loadValidationFromDb } from './routes/admin/settings.js';
import { registerExportImportRoutes } from './routes/admin/export-import.js';
import { seedDatabase } from './db/seed.js';
import { loadPlugins } from './plugins/plugin-loader.js';
import type { ValidationConfig } from '@star-cliproxy/shared';

export async function createApp(config: AppConfig, projectRoot?: string) {
  // admin token 검증 (빈 토큰으로 시작 방지)
  if (config.auth.enabled && !config.auth.adminToken) {
    throw new Error('ADMIN_TOKEN must be set when auth is enabled. Set it in .env or config.yaml.');
  }

  // DB 초기화
  initDatabase(config.database.path);

  // 시드 데이터 (초기 API 키, 모델 매핑)
  await seedDatabase(config);

  // Provider 레지스트리 (빌트인)
  const registry = createProviderRegistry(config.providers);

  // 플러그인 로드 (config.yaml의 plugins 섹션)
  if (config.plugins.length > 0) {
    const pluginResult = await loadPlugins(config.plugins, registry, {
      info: (msg) => console.log(`[plugin] ${msg}`),
      warn: (msg) => console.warn(`[plugin] ${msg}`),
    }, projectRoot);

    // 플러그인 프로바이더의 큐와 rate limit 설정
    for (const name of pluginResult.loaded) {
      const provider = registry.get(name);
      if (provider) {
        const pluginEntry = config.plugins.find((p) => {
          const providerObj = registry.get(name);
          return providerObj?.name === name;
        });
        const maxConcurrent = pluginEntry?.config?.max_concurrent ?? 2;
        config.providers[name] = {
          enabled: true,
          cli_path: pluginEntry?.config?.cli_path ?? '',
          default_model: pluginEntry?.config?.default_model ?? '',
          max_concurrent: maxConcurrent,
          timeout_ms: pluginEntry?.config?.timeout_ms ?? 120000,
          extra_args: pluginEntry?.config?.extra_args ?? [],
        };
        if (!config.rateLimits.perProvider[name]) {
          config.rateLimits.perProvider[name] = { rpm: 20 };
        }
      }
    }
  }

  // DB에서 저장된 Rate Limits 로드 (없으면 config.yaml 기본값 사용)
  const savedRateLimits = await loadRateLimitsFromDb(config.rateLimits);

  // DB에서 저장된 Validation 설정 로드 (없으면 config.yaml 기본값 사용)
  const savedValidation = await loadValidationFromDb();
  let currentValidation: ValidationConfig = savedValidation ?? { ...config.validation };

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
      queueManager.addQueue(name, providerConfig.max_concurrent);
    }
  }

  // DB에서 프로바이더 설정 오버라이드 로드 (이전 세션에서 대시보드로 변경한 값)
  for (const provider of registry.getAll()) {
    const override = await loadProviderConfigFromDb(provider.name);
    if (override) {
      registry.updateProviderConfig(provider.name, override);
      if (override.max_concurrent !== undefined) {
        queueManager.updateConcurrency(provider.name, override.max_concurrent);
      }
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
    validation: currentValidation,
    activeRequests,
    cache,
    debug,
  });
  registerMessagesRoute(app, {
    router,
    queue: queueManager,
    rateLimiter,
    registry,
    healthChecker,
    validation: currentValidation,
    activeRequests,
    cache,
    debug,
  });
  registerModelsRoute(app);
  registerImageGenerationsRoute(app, {
    router,
    queue: queueManager,
    rateLimiter,
    registry,
    healthChecker,
    activeRequests,
    debug,
  });

  // Admin 라우트 등록
  registerModelMappingsRoutes(app);
  registerApiKeysRoutes(app);
  registerStatsRoutes(app);
  registerProvidersRoutes(app, {
    registry,
    healthChecker,
    queueManager,
    defaultConfigs: config.providers,
  });
  registerTestModelRoute(app, registry);
  registerRateLimitsRoutes(app, rateLimiter, config.rateLimits);
  registerDebugRoutes(app, debug);
  registerSettingsRoutes(app, {
    getValidation: () => currentValidation,
    setValidation: (v) => {
      // 기존 객체의 프로퍼티를 덮어쓰기 (chat-completions가 참조 유지)
      Object.assign(currentValidation, v);
    },
  });
  registerExportImportRoutes(app, {
    rateLimiter,
    defaultRateLimits: config.rateLimits,
    getValidation: () => currentValidation,
    setValidation: (v) => { Object.assign(currentValidation, v); },
    config,
    registry,
    queueManager,
  });
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
