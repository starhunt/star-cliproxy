import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { ProviderConfigYaml } from '@star-cliproxy/shared';
import { getDatabase } from '../../db/client.js';
import { providerHealth, settings } from '../../db/schema.js';
// ProviderName은 string 타입
import type { HealthChecker } from '../../services/health-checker.js';
import type { QueueManager } from '../../services/queue.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import { readCodexCliDefaults } from '../../providers/codex-toml-defaults.js';

interface ProviderDeps {
  registry: ProviderRegistry;
  healthChecker: HealthChecker;
  queueManager: QueueManager;
  defaultConfigs: Record<string, ProviderConfigYaml>;
}

// DB 키 접두사
const PROVIDER_CONFIG_PREFIX = 'provider_config:';
const BUILTIN_PROVIDER_NAMES = new Set(['claude', 'codex', 'copilot', 'gemini', 'agy', 'grok']);
const BUILTIN_RUNTIME_MUTABLE_FIELDS = new Set([
  'enabled',
  'default_model',
  'max_concurrent',
  'timeout_ms',
  'mode',
  'sdk_options',
  'app_server_options',
  'cli_options',
]);

export function sanitizeRuntimeProviderConfig(
  name: string,
  partial: Partial<ProviderConfigYaml>,
  strict = false,
): Partial<ProviderConfigYaml> {
  if (!BUILTIN_PROVIDER_NAMES.has(name)) {
    return partial;
  }

  const sanitized: Partial<ProviderConfigYaml> = {};
  const rejected: string[] = [];

  for (const [key, value] of Object.entries(partial)) {
    if (BUILTIN_RUNTIME_MUTABLE_FIELDS.has(key)) {
      (sanitized as Record<string, unknown>)[key] = value;
    } else {
      rejected.push(key);
    }
  }

  if (strict && rejected.length > 0) {
    throw new Error(
      `Built-in provider "${name}" only supports runtime updates for: ${Array.from(BUILTIN_RUNTIME_MUTABLE_FIELDS).join(', ')}.`,
    );
  }

  return sanitized;
}

// DB에서 프로바이더 설정 오버라이드 로드
export async function loadProviderConfigFromDb(
  name: string,
): Promise<Partial<ProviderConfigYaml> | null> {
  const db = getDatabase();
  const key = `${PROVIDER_CONFIG_PREFIX}${name}`;
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);

  if (rows.length === 0) return null;
  try {
    return JSON.parse(rows[0].value) as Partial<ProviderConfigYaml>;
  } catch {
    return null;
  }
}

// DB에 프로바이더 설정 오버라이드 저장
async function saveProviderConfigToDb(
  name: string,
  config: Partial<ProviderConfigYaml>,
): Promise<void> {
  const db = getDatabase();
  const key = `${PROVIDER_CONFIG_PREFIX}${name}`;
  const now = new Date().toISOString();
  const value = JSON.stringify(config);

  const existing = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(settings).values({ key, value, updatedAt: now });
  } else {
    await db
      .update(settings)
      .set({ value, updatedAt: now })
      .where(eq(settings.key, key));
  }
}

export function registerProvidersRoutes(app: FastifyInstance, deps: ProviderDeps): void {
  // Provider 목록 + 상태
  app.get('/admin/providers', async (_request, reply) => {
    const db = getDatabase();
    const healthData = await db.select().from(providerHealth);
    const healthMap = new Map(healthData.map((h) => [h.provider, h]));

    const providers = deps.registry.getAll().map((p) => {
      const health = healthMap.get(p.name);
      const queueStatus = deps.queueManager.getStatus(p.name);

      return {
        name: p.name,
        status: health?.status ?? 'unknown',
        lastCheckAt: health?.lastCheckAt,
        lastSuccessAt: health?.lastSuccessAt,
        consecutiveFailures: health?.consecutiveFailures ?? 0,
        queue: queueStatus,
      };
    });

    return reply.send(providers);
  });

  // 개별 프로바이더 설정 조회
  app.get<{ Params: { name: string } }>('/admin/providers/:name/config', async (request, reply) => {
    const { name } = request.params;
    const config = deps.registry.getProviderConfig(name);

    if (!config) {
      return reply.status(404).send({ error: { message: `Provider "${name}" not found.` } });
    }

    return reply.send(config);
  });

  // Codex 한정: ~/.codex/config.toml에 명시된 글로벌 기본값.
  // 매핑에서 reasoning_effort를 비워둘 때 실제로 어떤 값이 적용되는지 UI에 표시하기 위함.
  app.get('/admin/providers/codex/cli-defaults', async (_request, reply) => {
    return reply.send(readCodexCliDefaults());
  });

  // 프로바이더 설정 변경 (인메모리 + DB 영속화)
  app.put<{ Params: { name: string }; Body: Partial<ProviderConfigYaml> }>(
    '/admin/providers/:name',
    async (request, reply) => {
      const { name } = request.params;

      if (!deps.registry.has(name)) {
        return reply.status(404).send({ error: { message: `Provider "${name}" not found.` } });
      }

      let partial: Partial<ProviderConfigYaml>;
      try {
        partial = sanitizeRuntimeProviderConfig(name, request.body, true);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: { message } });
      }

      // 인메모리 반영
      const updated = deps.registry.updateProviderConfig(name, partial);
      if (!updated) {
        return reply.status(500).send({ error: { message: `Failed to update provider "${name}" config.` } });
      }

      // max_concurrent 변경 시 큐 동시 처리 수도 갱신
      if (partial.max_concurrent !== undefined) {
        deps.queueManager.updateConcurrency(name, partial.max_concurrent);
      }

      // DB에 오버라이드 저장 (기존 오버라이드와 병합)
      const existingOverride = await loadProviderConfigFromDb(name);
      const merged = { ...existingOverride, ...partial };
      await saveProviderConfigToDb(name, merged);

      // 변경된 전체 config 반환
      const newConfig = deps.registry.getProviderConfig(name);
      return reply.send(newConfig);
    },
  );

  // 프로바이더 테스트 (기본 모델로 간단한 메시지 실행)
  app.post<{ Params: { name: string } }>('/admin/providers/:name/test', async (request, reply) => {
    const { name } = request.params;
    const provider = deps.registry.get(name);

    if (!provider) {
      return reply.status(404).send({ error: { message: `Provider "${name}" not found.` } });
    }

    const config = deps.registry.getProviderConfig(name);
    const model = config?.default_model ?? '';

    if (!model) {
      return reply.status(400).send({
        success: false,
        error: 'No default_model configured for this provider.',
      });
    }

    const startTime = Date.now();

    // chat이 아닌 프로바이더(images 등)는 적절한 테스트 프롬프트 사용
    const endpointTypes = (provider as unknown as { endpointTypes?: string[] }).endpointTypes;
    const isNonChat = endpointTypes && !endpointTypes.includes('chat');

    const testPrompt = isNonChat && endpointTypes?.includes('images')
      ? 'A simple test image: blue circle on white background'
      : 'Say "OK" and nothing else.';

    try {
      const result = await provider.execute({
        messages: [{ role: 'user', content: testPrompt }],
        model,
        stream: false,
      });

      const latencyMs = Date.now() - startTime;

      return reply.send({
        success: true,
        response: result.content.substring(0, 200),
        latencyMs,
        usage: result.usage,
      });
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);

      return reply.send({
        success: false,
        error: message,
        latencyMs,
      });
    }
  });

  // 수동 건강 체크
  app.post<{ Params: { name: string } }>('/admin/providers/:name/health-check', async (request, reply) => {
    const { name } = request.params;
    if (!deps.registry.has(name)) {
      return reply.status(404).send({ error: { message: `Provider "${name}" not found.` } });
    }

    const status = await deps.healthChecker.checkProvider(name);
    return reply.send({ provider: name, status });
  });
}
