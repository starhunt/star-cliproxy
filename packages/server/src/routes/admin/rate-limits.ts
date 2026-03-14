import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { RateLimitConfig, ProviderName } from '@star-cliproxy/shared';
import { getDatabase } from '../../db/client.js';
import { settings } from '../../db/schema.js';
import { RateLimiter } from '../../middleware/rate-limiter.js';

const RATE_LIMITS_KEY = 'rate_limits';

interface RateLimitsBody {
  global: { rpm: number; rpd: number };
  perProvider: {
    claude?: { rpm: number };
    codex?: { rpm: number };
    gemini?: { rpm: number };
  };
}

export function registerRateLimitsRoutes(
  app: FastifyInstance,
  rateLimiter: RateLimiter,
  defaultConfig: RateLimitConfig,
): void {
  // 현재 Rate Limits 조회
  app.get('/admin/rate-limits', async (_request, reply) => {
    const config = await loadRateLimitsFromDb(defaultConfig);
    return reply.send(config);
  });

  // Rate Limits 업데이트 (DB 저장 + 인메모리 즉시 반영)
  app.put<{ Body: RateLimitsBody }>('/admin/rate-limits', async (request, reply) => {
    const body = request.body;

    if (!body.global || typeof body.global.rpm !== 'number' || typeof body.global.rpd !== 'number') {
      return reply.status(400).send({ error: { message: 'global.rpm and global.rpd are required as numbers.' } });
    }

    const newConfig: RateLimitConfig = {
      global: {
        rpm: Math.max(1, Math.floor(body.global.rpm)),
        rpd: Math.max(1, Math.floor(body.global.rpd)),
      },
      perProvider: {
        claude: { rpm: Math.max(1, Math.floor(body.perProvider?.claude?.rpm ?? 20)) },
        codex: { rpm: Math.max(1, Math.floor(body.perProvider?.codex?.rpm ?? 20)) },
        gemini: { rpm: Math.max(1, Math.floor(body.perProvider?.gemini?.rpm ?? 20)) },
      },
    };

    // DB에 저장
    await saveRateLimitsToDb(newConfig);

    // 인메모리 즉시 반영
    rateLimiter.updateConfig(newConfig);

    return reply.send({ success: true, config: newConfig });
  });
}

// DB에서 Rate Limits 로드 (없으면 기본값 반환)
export async function loadRateLimitsFromDb(defaultConfig: RateLimitConfig): Promise<RateLimitConfig> {
  const db = getDatabase();
  const results = await db
    .select()
    .from(settings)
    .where(eq(settings.key, RATE_LIMITS_KEY))
    .limit(1);

  if (results.length === 0) {
    return defaultConfig;
  }

  try {
    return JSON.parse(results[0].value) as RateLimitConfig;
  } catch {
    return defaultConfig;
  }
}

async function saveRateLimitsToDb(config: RateLimitConfig): Promise<void> {
  const db = getDatabase();
  const now = new Date().toISOString();
  const value = JSON.stringify(config);

  const existing = await db
    .select()
    .from(settings)
    .where(eq(settings.key, RATE_LIMITS_KEY))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(settings).values({
      key: RATE_LIMITS_KEY,
      value,
      updatedAt: now,
    });
  } else {
    await db
      .update(settings)
      .set({ value, updatedAt: now })
      .where(eq(settings.key, RATE_LIMITS_KEY));
  }
}
