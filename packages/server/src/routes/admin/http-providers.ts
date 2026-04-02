import type { FastifyInstance } from 'fastify';
import { eq, like } from 'drizzle-orm';
import type { HttpProviderConfig } from '@star-cliproxy/shared';
import { getDatabase } from '../../db/client.js';
import { settings, providerHealth } from '../../db/schema.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { HealthChecker } from '../../services/health-checker.js';
import type { QueueManager } from '../../services/queue.js';
import { HttpProvider } from '../../providers/http-provider.js';

// DB 키 접두사
const HTTP_PROVIDER_PREFIX = 'http_provider:';
const PROVIDER_CONFIG_PREFIX = 'provider_config:';

// 빌트인 프로바이더 이름 (사용 불가)
const BUILTIN_PROVIDER_NAMES = ['claude', 'codex', 'copilot', 'gemini'];

// 프로바이더 이름 유효성 검사 패턴: 소문자·숫자·하이픈, 길이 2-30
const PROVIDER_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// base_url 유효성 검사
function validateBaseUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return 'Only http:// and https:// protocols are allowed.';
    }
    return null;
  } catch {
    return `Invalid URL: "${url}".`;
  }
}

function validateProviderName(name: string): string | null {
  if (!PROVIDER_NAME_PATTERN.test(name)) {
    return `Provider name "${name}" is invalid. Use lowercase letters, numbers, and hyphens only (length 2-30).`;
  }
  if (name.length < 2 || name.length > 30) {
    return `Provider name must be between 2 and 30 characters.`;
  }
  return null;
}

// DB 헬퍼
async function loadHttpProviderFromDb(name: string): Promise<HttpProviderConfig | null> {
  const db = getDatabase();
  const key = `${HTTP_PROVIDER_PREFIX}${name}`;
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);

  if (rows.length === 0) return null;
  try {
    return JSON.parse(rows[0].value) as HttpProviderConfig;
  } catch {
    return null;
  }
}

async function saveHttpProviderToDb(name: string, config: HttpProviderConfig): Promise<void> {
  const db = getDatabase();
  const key = `${HTTP_PROVIDER_PREFIX}${name}`;
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

interface HttpProviderDeps {
  registry: ProviderRegistry;
  healthChecker: HealthChecker;
  queueManager: QueueManager;
}

export function registerHttpProviderRoutes(
  app: FastifyInstance,
  deps: HttpProviderDeps,
): void {
  // 전체 HTTP 프로바이더 목록 조회
  app.get('/admin/http-providers', async (_request, reply) => {
    const db = getDatabase();
    const rows = await db
      .select()
      .from(settings)
      .where(like(settings.key, `${HTTP_PROVIDER_PREFIX}%`));

    const providers = rows.map((row) => {
      const name = row.key.replace(HTTP_PROVIDER_PREFIX, '');
      try {
        const config = JSON.parse(row.value) as HttpProviderConfig;
        return { name, config };
      } catch {
        return null;
      }
    }).filter(Boolean);

    return reply.send(providers);
  });

  // 특정 HTTP 프로바이더 설정 조회
  app.get<{ Params: { name: string } }>(
    '/admin/http-providers/:name',
    async (request, reply) => {
      const { name } = request.params;
      const config = await loadHttpProviderFromDb(name);

      if (!config) {
        return reply.status(404).send({
          error: { message: `HTTP provider "${name}" not found.` },
        });
      }

      return reply.send({ name, config });
    },
  );

  // HTTP 프로바이더 생성
  app.post<{ Body: { name: string } & Partial<HttpProviderConfig> }>(
    '/admin/http-providers',
    async (request, reply) => {
      const { name, ...configData } = request.body;

      // 이름 유효성 검사
      if (!name) {
        return reply.status(400).send({ error: { message: 'Provider name is required.' } });
      }
      const nameError = validateProviderName(name);
      if (nameError) {
        return reply.status(400).send({ error: { message: nameError } });
      }

      // 빌트인 이름 충돌
      if (BUILTIN_PROVIDER_NAMES.includes(name)) {
        return reply.status(409).send({
          error: { message: `Cannot use built-in provider name: "${name}".` },
        });
      }

      // 이미 등록된 프로바이더 이름 확인
      if (deps.registry.has(name)) {
        return reply.status(409).send({
          error: { message: `Provider "${name}" is already registered.` },
        });
      }

      // base_url 유효성 검사
      if (!configData.base_url) {
        return reply.status(400).send({ error: { message: 'base_url is required.' } });
      }
      const urlError = validateBaseUrl(configData.base_url);
      if (urlError) {
        return reply.status(400).send({ error: { message: urlError } });
      }

      const config: HttpProviderConfig = {
        enabled: configData.enabled ?? true,
        base_url: configData.base_url,
        default_model: configData.default_model ?? '',
        max_concurrent: configData.max_concurrent ?? 5,
        timeout_ms: configData.timeout_ms ?? 300000,
        display_name: configData.display_name ?? name,
        ...(configData.api_key !== undefined && { api_key: configData.api_key }),
        ...(configData.custom_headers !== undefined && { custom_headers: configData.custom_headers }),
        ...(configData.description !== undefined && { description: configData.description }),
      };

      // DB에 저장
      await saveHttpProviderToDb(name, config);

      // 런타임 등록
      const provider = new HttpProvider(name, config);
      deps.registry.register(provider);
      deps.queueManager.addQueue(name, config.max_concurrent);

      // 비동기 헬스 체크
      deps.healthChecker.checkProvider(name).catch(() => {});

      return reply.status(201).send({ name, config });
    },
  );

  // HTTP 프로바이더 설정 수정
  app.put<{ Params: { name: string }; Body: Partial<HttpProviderConfig> }>(
    '/admin/http-providers/:name',
    async (request, reply) => {
      const { name } = request.params;
      const partial = request.body;

      const existing = await loadHttpProviderFromDb(name);
      if (!existing) {
        return reply.status(404).send({
          error: { message: `HTTP provider "${name}" not found.` },
        });
      }

      // base_url 변경 시 유효성 검사
      if (partial.base_url !== undefined) {
        const urlError = validateBaseUrl(partial.base_url);
        if (urlError) {
          return reply.status(400).send({ error: { message: urlError } });
        }
      }

      const updated: HttpProviderConfig = { ...existing, ...partial };
      await saveHttpProviderToDb(name, updated);

      // 구조적 변경 여부 (base_url, api_key, custom_headers 변경 시 재등록)
      const structuralFields: Array<keyof HttpProviderConfig> = [
        'base_url', 'api_key', 'custom_headers',
      ];
      const hasStructuralChange = structuralFields.some(
        (field) => partial[field] !== undefined,
      );

      if (hasStructuralChange && deps.registry.has(name)) {
        deps.registry.unregister(name);
        const newProvider = new HttpProvider(name, updated);
        deps.registry.register(newProvider);
      } else if (deps.registry.has(name)) {
        // HttpProvider의 httpConfig도 업데이트
        const provider = deps.registry.get(name);
        if (provider instanceof HttpProvider) {
          provider.updateHttpConfig(partial);
        }
      }

      if (partial.max_concurrent !== undefined) {
        deps.queueManager.updateConcurrency(name, partial.max_concurrent);
      }

      return reply.send({ name, config: updated });
    },
  );

  // HTTP 프로바이더 삭제
  app.delete<{ Params: { name: string } }>(
    '/admin/http-providers/:name',
    async (request, reply) => {
      const { name } = request.params;

      if (BUILTIN_PROVIDER_NAMES.includes(name)) {
        return reply.status(403).send({
          error: { message: `Cannot delete built-in provider: "${name}".` },
        });
      }

      const existing = await loadHttpProviderFromDb(name);
      if (!existing) {
        return reply.status(404).send({
          error: { message: `HTTP provider "${name}" not found.` },
        });
      }

      const db = getDatabase();

      await db.delete(settings).where(eq(settings.key, `${HTTP_PROVIDER_PREFIX}${name}`));
      await db.delete(settings).where(eq(settings.key, `${PROVIDER_CONFIG_PREFIX}${name}`));
      await db.delete(providerHealth).where(eq(providerHealth.provider, name));

      if (deps.registry.has(name)) {
        deps.registry.unregister(name);
      }
      deps.queueManager.removeQueue(name);

      return reply.send({ success: true });
    },
  );

  // 등록 전 테스트 — 임시 HttpProvider로 실행
  app.post<{ Body: { name?: string } & Partial<HttpProviderConfig> }>(
    '/admin/http-providers/test',
    async (request, reply) => {
      const { name, ...configData } = request.body;
      const providerName = name || '__http_test__';

      if (!configData.base_url) {
        return reply.status(400).send({ error: { message: 'base_url is required.' } });
      }
      const urlError = validateBaseUrl(configData.base_url);
      if (urlError) {
        return reply.status(400).send({ error: { message: urlError } });
      }

      const config: HttpProviderConfig = {
        enabled: true,
        base_url: configData.base_url,
        default_model: configData.default_model ?? '',
        max_concurrent: 10,
        timeout_ms: configData.timeout_ms ?? 300000,
        display_name: configData.display_name ?? providerName,
        ...(configData.api_key !== undefined && { api_key: configData.api_key }),
        ...(configData.custom_headers !== undefined && { custom_headers: configData.custom_headers }),
      };

      const testProvider = new HttpProvider(providerName, config);
      const model = config.default_model || '';
      const startTime = Date.now();

      try {
        const result = await testProvider.execute({
          messages: [{ role: 'user', content: 'Say "OK" and nothing else.' }],
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
        return reply.send({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          latencyMs,
        });
      }
    },
  );
}
