import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDatabase } from '../../db/client.js';
import { settings } from '../../db/schema.js';
import type { ValidationConfig } from '@star-cliproxy/shared';

const VALIDATION_KEY = 'validation_config';

interface SettingsDeps {
  getValidation: () => ValidationConfig;
  setValidation: (config: ValidationConfig) => void;
}

export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsDeps): void {
  // 현재 validation 설정 조회
  app.get('/admin/settings/validation', async (_request, reply) => {
    return reply.send(deps.getValidation());
  });

  // validation 설정 변경 (DB에 저장 + 런타임 반영)
  app.put<{ Body: Partial<ValidationConfig> }>('/admin/settings/validation', async (request, reply) => {
    const current = deps.getValidation();
    const body = request.body;

    const updated: ValidationConfig = {
      maxMessageCount: body.maxMessageCount ?? current.maxMessageCount,
      maxMessageLength: body.maxMessageLength ?? current.maxMessageLength,
      maxPromptLength: body.maxPromptLength ?? current.maxPromptLength,
      maxResponseLength: body.maxResponseLength ?? current.maxResponseLength,
      bodyLimitBytes: body.bodyLimitBytes ?? current.bodyLimitBytes,
    };

    // DB에 저장
    const db = getDatabase();
    const existing = await db.select().from(settings).where(eq(settings.key, VALIDATION_KEY)).limit(1);
    if (existing.length > 0) {
      await db.update(settings).set({
        value: JSON.stringify(updated),
        updatedAt: new Date().toISOString(),
      }).where(eq(settings.key, VALIDATION_KEY));
    } else {
      await db.insert(settings).values({
        key: VALIDATION_KEY,
        value: JSON.stringify(updated),
        updatedAt: new Date().toISOString(),
      });
    }

    // 런타임에 즉시 반영
    deps.setValidation(updated);

    return reply.send(updated);
  });
}

// DB에서 저장된 validation 설정 로드 (없으면 null)
export async function loadValidationFromDb(): Promise<ValidationConfig | null> {
  try {
    const db = getDatabase();
    const result = await db.select().from(settings).where(eq(settings.key, VALIDATION_KEY)).limit(1);
    if (result.length > 0) {
      return JSON.parse(result[0].value) as ValidationConfig;
    }
  } catch { /* DB 아직 초기화 안 됐거나 파싱 실패 */ }
  return null;
}
