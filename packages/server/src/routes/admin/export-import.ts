import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AppConfig, RateLimitConfig, ValidationConfig, ProviderConfigYaml, GenericCliProviderConfig } from '@star-cliproxy/shared';
import { API_KEY_PREFIX, isReasoningEffort } from '@star-cliproxy/shared';
import { GenericCliProvider } from '../../providers/generic-cli-provider.js';
import { getDatabase } from '../../db/client.js';
import { modelMappings, apiKeys, settings } from '../../db/schema.js';
import { RateLimiter } from '../../middleware/rate-limiter.js';
import { hashApiKey, getKeyPrefix } from '../../middleware/auth.js';
import { loadRateLimitsFromDb } from './rate-limits.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { QueueManager } from '../../services/queue.js';
import type { HealthChecker } from '../../services/health-checker.js';
import { sanitizeRuntimeProviderConfig } from './providers.js';

const RATE_LIMITS_KEY = 'rate_limits';
const VALIDATION_KEY = 'validation_config';
const GENERIC_PROVIDER_PREFIX = 'generic_provider:';
const EXPORT_VERSION = 2;

interface ExportImportDeps {
  rateLimiter: RateLimiter;
  defaultRateLimits: RateLimitConfig;
  getValidation: () => ValidationConfig;
  setValidation: (v: Partial<ValidationConfig>) => void;
  config: AppConfig;
  registry: ProviderRegistry;
  queueManager: QueueManager;
  healthChecker: HealthChecker;
}

interface ExportData {
  version: number;
  exportedAt: string;
  modelMappings: Array<{
    alias: string;
    provider: string;
    actualModel: string;
    displayName: string | null;
    reasoningEffort?: string | null;
    priority: number;
    enabled: boolean;
  }>;
  rateLimits: RateLimitConfig;
  validation: ValidationConfig;
  apiKeys: Array<{
    name: string;
    enabled: boolean;
    rateLimitRpm: number | null;
    rateLimitRpd: number | null;
  }>;
  providers: Record<string, {
    enabled: boolean;
    cli_path: string;
    default_model: string;
    max_concurrent: number;
    timeout_ms: number;
    extra_args: string[];
    working_dir?: string;
  }>;
  genericProviders?: Record<string, GenericCliProviderConfig>;
}

interface ImportResult {
  success: boolean;
  imported: {
    modelMappings: number;
    rateLimits: boolean;
    validation: boolean;
    apiKeys: { created: number; updated: number };
    providers: number;
  };
  skipped: string[];
}

// Import 데이터의 각 섹션 구조를 수동 검증 (외부 의존성 없이)
function validateExportData(body: unknown): string | null {
  const data = body as Record<string, unknown>;

  // modelMappings 검증
  if (data.modelMappings !== undefined) {
    if (!Array.isArray(data.modelMappings)) return 'modelMappings must be an array';
    for (const m of data.modelMappings) {
      if (!m || typeof m !== 'object') return 'modelMappings items must be objects';
      const mapping = m as Record<string, unknown>;
      if (typeof mapping.alias !== 'string' || !mapping.alias) return 'modelMappings.alias is required';
      if (typeof mapping.provider !== 'string' || !mapping.provider) return 'modelMappings.provider is required';
      if (typeof mapping.actualModel !== 'string' || !mapping.actualModel) return 'modelMappings.actualModel is required';
    }
  }

  // rateLimits 검증
  if (data.rateLimits !== undefined) {
    if (!data.rateLimits || typeof data.rateLimits !== 'object') return 'rateLimits must be an object';
    const rl = data.rateLimits as Record<string, unknown>;
    if (!rl.global || typeof rl.global !== 'object') return 'rateLimits.global is required';
    const global = rl.global as Record<string, unknown>;
    if (typeof global.rpm !== 'number' || typeof global.rpd !== 'number') return 'rateLimits.global.rpm and rpd must be numbers';
  }

  // validation 검증
  if (data.validation !== undefined) {
    if (!data.validation || typeof data.validation !== 'object') return 'validation must be an object';
  }

  // apiKeys 검증
  if (data.apiKeys !== undefined) {
    if (!Array.isArray(data.apiKeys)) return 'apiKeys must be an array';
    for (const k of data.apiKeys) {
      if (!k || typeof k !== 'object') return 'apiKeys items must be objects';
      const key = k as Record<string, unknown>;
      if (typeof key.name !== 'string' || !key.name) return 'apiKeys.name is required';
    }
  }

  // providers 검증
  if (data.providers !== undefined) {
    if (!data.providers || typeof data.providers !== 'object') return 'providers must be an object';
  }

  return null; // 유효
}

export function registerExportImportRoutes(
  app: FastifyInstance,
  deps: ExportImportDeps,
): void {
  // 전체 설정 내보내기
  app.get('/admin/export', async (_request, reply) => {
    const db = getDatabase();

    // 모델 매핑 조회
    const mappings = await db.select({
      alias: modelMappings.alias,
      provider: modelMappings.provider,
      actualModel: modelMappings.actualModel,
      displayName: modelMappings.displayName,
      reasoningEffort: modelMappings.reasoningEffort,
      priority: modelMappings.priority,
      enabled: modelMappings.enabled,
    }).from(modelMappings);

    // Rate Limits 조회
    const rateLimits = await loadRateLimitsFromDb(deps.defaultRateLimits);

    // Validation 조회
    const validation = deps.getValidation();

    // API 키 조회 (keyHash 제외 — 보안)
    const keys = await db.select({
      name: apiKeys.name,
      enabled: apiKeys.enabled,
      rateLimitRpm: apiKeys.rateLimitRpm,
      rateLimitRpd: apiKeys.rateLimitRpd,
    }).from(apiKeys);

    // Providers (현재 런타임 설정 — DB 오버라이드 반영)
    const providers: ExportData['providers'] = {};
    for (const provider of deps.registry.getAll()) {
      const config = deps.registry.getProviderConfig(provider.name);
      if (config) {
        providers[provider.name] = {
          enabled: config.enabled,
          cli_path: config.cli_path,
          default_model: config.default_model,
          max_concurrent: config.max_concurrent,
          timeout_ms: config.timeout_ms,
          extra_args: config.extra_args,
          working_dir: config.working_dir,
        };
      }
    }

    // Generic 프로바이더 (DB에서 조회)
    const genericProviders: Record<string, GenericCliProviderConfig> = {};
    const allSettings = await db.select().from(settings);
    for (const row of allSettings) {
      if (row.key.startsWith(GENERIC_PROVIDER_PREFIX)) {
        const name = row.key.replace(GENERIC_PROVIDER_PREFIX, '');
        try {
          genericProviders[name] = JSON.parse(row.value) as GenericCliProviderConfig;
        } catch { /* 파싱 실패 무시 */ }
      }
    }

    const exportData: ExportData = {
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      modelMappings: mappings,
      rateLimits,
      validation,
      apiKeys: keys,
      providers,
      ...(Object.keys(genericProviders).length > 0 && { genericProviders }),
    };

    return reply.send(exportData);
  });

  // 설정 불러오기
  app.post<{ Body: ExportData }>('/admin/import', async (request, reply) => {
    const body = request.body;

    // version 검증 (v1, v2 모두 허용)
    if (!body.version || body.version > EXPORT_VERSION) {
      return reply.status(400).send({
        error: { message: `Unsupported export version: ${body.version}. Expected: ${EXPORT_VERSION} or lower.` },
      });
    }

    // 각 섹션 구조 검증
    const validationError = validateExportData(body);
    if (validationError) {
      return reply.status(400).send({
        error: { message: `Invalid import data: ${validationError}` },
      });
    }

    const db = getDatabase();
    const skipped: string[] = [];
    let mappingsCount = 0;
    let rateLimitsImported = false;
    let validationImported = false;
    let keysCreated = 0;
    let keysUpdated = 0;

    // 1. 모델 매핑: 기존 전부 삭제 후 새로 삽입 (replace 전략)
    if (body.modelMappings && Array.isArray(body.modelMappings)) {
      await db.delete(modelMappings);
      const now = new Date().toISOString();

      for (const mapping of body.modelMappings) {
        if (!mapping.alias || !mapping.provider || !mapping.actualModel) continue;
        // 화이트리스트 외 reasoning_effort는 silently 무시 (import 호환성)
        const rawEffort = typeof mapping.reasoningEffort === 'string'
          ? mapping.reasoningEffort.trim().toLowerCase()
          : null;
        const effort = rawEffort && isReasoningEffort(rawEffort) ? rawEffort : null;
        await db.insert(modelMappings).values({
          id: nanoid(),
          alias: mapping.alias,
          provider: mapping.provider,
          actualModel: mapping.actualModel,
          displayName: mapping.displayName ?? null,
          reasoningEffort: effort,
          priority: mapping.priority ?? 0,
          enabled: mapping.enabled ?? true,
          createdAt: now,
          updatedAt: now,
        });
        mappingsCount++;
      }
    }

    // 2. Rate Limits: settings 테이블에 upsert
    if (body.rateLimits) {
      const value = JSON.stringify(body.rateLimits);
      const now = new Date().toISOString();
      const existing = await db.select().from(settings).where(eq(settings.key, RATE_LIMITS_KEY)).limit(1);

      if (existing.length === 0) {
        await db.insert(settings).values({ key: RATE_LIMITS_KEY, value, updatedAt: now });
      } else {
        await db.update(settings).set({ value, updatedAt: now }).where(eq(settings.key, RATE_LIMITS_KEY));
      }

      // 인메모리 즉시 반영
      deps.rateLimiter.updateConfig(body.rateLimits);
      rateLimitsImported = true;
    }

    // 3. Validation: settings 테이블에 upsert
    if (body.validation) {
      const currentValidation = deps.getValidation();
      const normalizedValidation: ValidationConfig = {
        ...body.validation,
        // Fastify bodyLimit는 런타임 변경 불가 — 현재 값 유지
        bodyLimitBytes: currentValidation.bodyLimitBytes,
      };
      const value = JSON.stringify(normalizedValidation);
      const now = new Date().toISOString();
      const existing = await db.select().from(settings).where(eq(settings.key, VALIDATION_KEY)).limit(1);

      if (existing.length === 0) {
        await db.insert(settings).values({ key: VALIDATION_KEY, value, updatedAt: now });
      } else {
        await db.update(settings).set({ value, updatedAt: now }).where(eq(settings.key, VALIDATION_KEY));
      }

      // 인메모리 즉시 반영
      deps.setValidation(normalizedValidation);
      validationImported = true;
    }

    // 4. API 키: name 기반 매칭 — 없으면 새 키 생성, 있으면 설정만 업데이트
    if (body.apiKeys && Array.isArray(body.apiKeys)) {
      for (const keyData of body.apiKeys) {
        if (!keyData.name) continue;

        const existing = await db.select().from(apiKeys).where(eq(apiKeys.name, keyData.name)).limit(1);

        if (existing.length === 0) {
          // 새 키 생성 (키 자동 생성)
          const rawKey = `${API_KEY_PREFIX}${randomBytes(24).toString('hex')}`;
          await db.insert(apiKeys).values({
            id: nanoid(),
            keyHash: hashApiKey(rawKey),
            keyPrefix: getKeyPrefix(rawKey),
            name: keyData.name,
            enabled: keyData.enabled ?? true,
            rateLimitRpm: keyData.rateLimitRpm ?? null,
            rateLimitRpd: keyData.rateLimitRpd ?? null,
            createdAt: new Date().toISOString(),
          });
          keysCreated++;
        } else {
          // 기존 키 설정만 업데이트 (keyHash는 변경하지 않음)
          const updates: Record<string, unknown> = {};
          if (keyData.enabled !== undefined) updates.enabled = keyData.enabled;
          if (keyData.rateLimitRpm !== undefined) updates.rateLimitRpm = keyData.rateLimitRpm;
          if (keyData.rateLimitRpd !== undefined) updates.rateLimitRpd = keyData.rateLimitRpd;

          if (Object.keys(updates).length > 0) {
            await db.update(apiKeys).set(updates).where(eq(apiKeys.id, existing[0].id));
          }
          keysUpdated++;
        }
      }
    }

    // 5. Providers: DB 오버라이드로 저장 + 인메모리 반영
    let providersImported = 0;
    if (body.providers && typeof body.providers === 'object') {
      const now = new Date().toISOString();
      for (const [name, providerConfig] of Object.entries(body.providers)) {
        // 레지스트리에 존재하는 프로바이더만 적용
        if (!deps.registry.getProviderConfig(name)) {
          skipped.push(`provider "${name}" (not registered)`);
          continue;
        }

        const override: Partial<ProviderConfigYaml> = {};
        if (providerConfig.enabled !== undefined) override.enabled = providerConfig.enabled;
        if (providerConfig.default_model !== undefined) override.default_model = providerConfig.default_model;
        if (providerConfig.max_concurrent !== undefined) override.max_concurrent = providerConfig.max_concurrent;
        if (providerConfig.timeout_ms !== undefined) override.timeout_ms = providerConfig.timeout_ms;
        if (providerConfig.extra_args !== undefined) override.extra_args = providerConfig.extra_args;
        if (providerConfig.working_dir !== undefined) override.working_dir = providerConfig.working_dir;
        if (providerConfig.cli_path !== undefined) override.cli_path = providerConfig.cli_path;

        const sanitizedOverride = sanitizeRuntimeProviderConfig(name, override);
        if (Object.keys(sanitizedOverride).length === 0) continue;

        // 인메모리 반영
        deps.registry.updateProviderConfig(name, sanitizedOverride);
        if (sanitizedOverride.max_concurrent) {
          deps.queueManager.updateConcurrency(name, sanitizedOverride.max_concurrent);
        }

        // DB 영속화
        const dbKey = `provider_config:${name}`;
        const existing = await db.select().from(settings).where(eq(settings.key, dbKey)).limit(1);
        const existingOverride = existing.length > 0
          ? sanitizeRuntimeProviderConfig(name, JSON.parse(existing[0].value) as Partial<ProviderConfigYaml>)
          : {};
        const merged = { ...existingOverride, ...sanitizedOverride };

        if (existing.length === 0) {
          await db.insert(settings).values({ key: dbKey, value: JSON.stringify(merged), updatedAt: now });
        } else {
          await db.update(settings).set({ value: JSON.stringify(merged), updatedAt: now }).where(eq(settings.key, dbKey));
        }

        providersImported++;
      }
    }

    // 6. Generic 프로바이더: DB 저장 + 런타임 등록
    let genericProvidersImported = 0;
    if (body.genericProviders && typeof body.genericProviders === 'object') {
      const now = new Date().toISOString();
      const BUILTIN_NAMES = ['claude', 'codex', 'copilot', 'gemini', 'agy', 'grok'];

      for (const [name, genericConfig] of Object.entries(body.genericProviders)) {
        // 빌트인 이름 충돌 방지
        if (BUILTIN_NAMES.includes(name)) {
          skipped.push(`generic provider "${name}" (conflicts with built-in)`);
          continue;
        }
        if (!genericConfig.cli_path) {
          skipped.push(`generic provider "${name}" (missing cli_path)`);
          continue;
        }

        // DB 저장 (upsert)
        const dbKey = `${GENERIC_PROVIDER_PREFIX}${name}`;
        const value = JSON.stringify(genericConfig);
        const existing = await db.select().from(settings).where(eq(settings.key, dbKey)).limit(1);

        if (existing.length === 0) {
          await db.insert(settings).values({ key: dbKey, value, updatedAt: now });
        } else {
          await db.update(settings).set({ value, updatedAt: now }).where(eq(settings.key, dbKey));
        }

        // 런타임 등록 (기존이면 교체)
        if (deps.registry.has(name)) {
          deps.registry.unregister(name);
        }
        if (genericConfig.enabled !== false) {
          const provider = new GenericCliProvider(name, genericConfig);
          deps.registry.register(provider);
          deps.queueManager.addQueue(name, genericConfig.max_concurrent);
          deps.healthChecker.checkProvider(name).catch(() => {});
        }

        genericProvidersImported++;
      }
    }

    const result: ImportResult = {
      success: true,
      imported: {
        modelMappings: mappingsCount,
        rateLimits: rateLimitsImported,
        validation: validationImported,
        apiKeys: { created: keysCreated, updated: keysUpdated },
        providers: providersImported + genericProvidersImported,
      },
      skipped,
    };

    return reply.send(result);
  });
}
