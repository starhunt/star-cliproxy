import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDatabase } from '../../db/client.js';
import { apiKeys } from '../../db/schema.js';
import { hashApiKey, getKeyPrefix } from '../../middleware/auth.js';
import { API_KEY_PREFIX } from '@star-cliproxy/shared';

interface CreateKeyBody {
  name: string;
  rate_limit_rpm?: number;
  rate_limit_rpd?: number;
  expires_at?: string;
}

interface UpdateKeyBody {
  name?: string;
  enabled?: boolean;
  rate_limit_rpm?: number | null;
  rate_limit_rpd?: number | null;
  expires_at?: string | null;
}

export function registerApiKeysRoutes(app: FastifyInstance): void {
  // 목록 (key_hash 제외, prefix만 노출)
  app.get('/admin/api-keys', async (_request, reply) => {
    const db = getDatabase();
    const all = await db.select({
      id: apiKeys.id,
      keyPrefix: apiKeys.keyPrefix,
      name: apiKeys.name,
      enabled: apiKeys.enabled,
      rateLimitRpm: apiKeys.rateLimitRpm,
      rateLimitRpd: apiKeys.rateLimitRpd,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
    }).from(apiKeys);
    return reply.send(all);
  });

  // 생성 (전체 키는 생성 시에만 반환)
  app.post<{ Body: CreateKeyBody }>('/admin/api-keys', async (request, reply) => {
    const { name, rate_limit_rpm, rate_limit_rpd, expires_at } = request.body;

    if (!name) {
      return reply.status(400).send({ error: { message: 'name is required.' } });
    }

    const rawKey = `${API_KEY_PREFIX}${randomBytes(24).toString('hex')}`;
    const db = getDatabase();
    const id = nanoid();

    await db.insert(apiKeys).values({
      id,
      keyHash: hashApiKey(rawKey),
      keyPrefix: getKeyPrefix(rawKey),
      name,
      enabled: true,
      rateLimitRpm: rate_limit_rpm,
      rateLimitRpd: rate_limit_rpd,
      createdAt: new Date().toISOString(),
      expiresAt: expires_at,
    });

    return reply.status(201).send({
      id,
      key: rawKey, // 생성 시에만 전체 키 반환
      key_prefix: getKeyPrefix(rawKey),
      name,
      message: 'Save this key securely. It will not be shown again.',
    });
  });

  // 수정
  app.put<{ Params: { id: string }; Body: UpdateKeyBody }>('/admin/api-keys/:id', async (request, reply) => {
    const { id } = request.params;
    const body = request.body;
    const db = getDatabase();

    const existing = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    if (existing.length === 0) {
      return reply.status(404).send({ error: { message: 'API key not found.' } });
    }

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.rate_limit_rpm !== undefined) updates.rateLimitRpm = body.rate_limit_rpm;
    if (body.rate_limit_rpd !== undefined) updates.rateLimitRpd = body.rate_limit_rpd;
    if (body.expires_at !== undefined) updates.expiresAt = body.expires_at;

    await db.update(apiKeys).set(updates).where(eq(apiKeys.id, id));

    const updated = await db.select({
      id: apiKeys.id,
      keyPrefix: apiKeys.keyPrefix,
      name: apiKeys.name,
      enabled: apiKeys.enabled,
      rateLimitRpm: apiKeys.rateLimitRpm,
      rateLimitRpd: apiKeys.rateLimitRpd,
      expiresAt: apiKeys.expiresAt,
    }).from(apiKeys).where(eq(apiKeys.id, id)).limit(1);

    return reply.send(updated[0]);
  });

  // 삭제
  app.delete<{ Params: { id: string } }>('/admin/api-keys/:id', async (request, reply) => {
    const { id } = request.params;
    const db = getDatabase();

    await db.delete(apiKeys).where(eq(apiKeys.id, id));
    return reply.status(204).send();
  });
}
