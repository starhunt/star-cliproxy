import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AppConfig, RateLimitConfig, ValidationConfig, ProviderConfigYaml } from '@star-cliproxy/shared';
import { API_KEY_PREFIX } from '@star-cliproxy/shared';
import { getDatabase } from '../../db/client.js';
import { modelMappings, apiKeys, settings } from '../../db/schema.js';
import { RateLimiter } from '../../middleware/rate-limiter.js';
import { hashApiKey, getKeyPrefix } from '../../middleware/auth.js';
import { loadRateLimitsFromDb } from './rate-limits.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { QueueManager } from '../../services/queue.js';

const RATE_LIMITS_KEY = 'rate_limits';
const VALIDATION_KEY = 'validation_config';
const EXPORT_VERSION = 1;

interface ExportImportDeps {
  rateLimiter: RateLimiter;
  defaultRateLimits: RateLimitConfig;
  getValidation: () => ValidationConfig;
  setValidation: (v: Partial<ValidationConfig>) => void;
  config: AppConfig;
  registry: ProviderRegistry;
  queueManager: QueueManager;
}

interface ExportData {
  version: number;
  exportedAt: string;
  modelMappings: Array<{
    alias: string;
    provider: string;
    actualModel: string;
    displayName: string | null;
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

    const exportData: ExportData = {
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      modelMappings: mappings,
      rateLimits,
      validation,
      apiKeys: keys,
      providers,
    };

    return reply.send(exportData);
  });

  // 설정 불러오기
  app.post<{ Body: ExportData }>('/admin/import', async (request, reply) => {
    const body = request.body;

    // version 검증
    if (!body.version || body.version !== EXPORT_VERSION) {
      return reply.status(400).send({
        error: { message: `Unsupported export version: ${body.version}. Expected: ${EXPORT_VERSION}` },
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
        await db.insert(modelMappings).values({
          id: nanoid(),
          alias: mapping.alias,
          provider: mapping.provider,
          actualModel: mapping.actualModel,
          displayName: mapping.displayName ?? null,
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
      const value = JSON.stringify(body.validation);
      const now = new Date().toISOString();
      const existing = await db.select().from(settings).where(eq(settings.key, VALIDATION_KEY)).limit(1);

      if (existing.length === 0) {
        await db.insert(settings).values({ key: VALIDATION_KEY, value, updatedAt: now });
      } else {
        await db.update(settings).set({ value, updatedAt: now }).where(eq(settings.key, VALIDATION_KEY));
      }

      // 인메모리 즉시 반영
      deps.setValidation(body.validation);
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
        if (providerConfig.default_model !== undefined) override.default_model = providerConfig.default_model;
        if (providerConfig.max_concurrent !== undefined) override.max_concurrent = providerConfig.max_concurrent;
        if (providerConfig.timeout_ms !== undefined) override.timeout_ms = providerConfig.timeout_ms;
        if (providerConfig.extra_args !== undefined) override.extra_args = providerConfig.extra_args;
        if (providerConfig.working_dir !== undefined) override.working_dir = providerConfig.working_dir;
        if (providerConfig.cli_path !== undefined) override.cli_path = providerConfig.cli_path;

        if (Object.keys(override).length === 0) continue;

        // 인메모리 반영
        deps.registry.updateProviderConfig(name, override);
        if (override.max_concurrent) {
          deps.queueManager.updateConcurrency(name, override.max_concurrent);
        }

        // DB 영속화
        const dbKey = `provider_config:${name}`;
        const existing = await db.select().from(settings).where(eq(settings.key, dbKey)).limit(1);
        const existingOverride = existing.length > 0 ? JSON.parse(existing[0].value) : {};
        const merged = { ...existingOverride, ...override };

        if (existing.length === 0) {
          await db.insert(settings).values({ key: dbKey, value: JSON.stringify(merged), updatedAt: now });
        } else {
          await db.update(settings).set({ value: JSON.stringify(merged), updatedAt: now }).where(eq(settings.key, dbKey));
        }

        providersImported++;
      }
    }

    const result: ImportResult = {
      success: true,
      imported: {
        modelMappings: mappingsCount,
        rateLimits: rateLimitsImported,
        validation: validationImported,
        apiKeys: { created: keysCreated, updated: keysUpdated },
        providers: providersImported,
      },
      skipped,
    };

    return reply.send(result);
  });
}
