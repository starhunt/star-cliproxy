import { createHash } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { getDatabase } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import { API_KEY_PREFIX } from '@star-cliproxy/shared';

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function getKeyPrefix(key: string): string {
  return key.substring(0, 12);
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    reply.status(401).send({
      error: {
        message: 'Missing or invalid Authorization header. Expected: Bearer sk-proxy-xxx',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_api_key',
      },
    });
    return;
  }

  const apiKey = authHeader.substring(7);

  if (!apiKey.startsWith(API_KEY_PREFIX)) {
    reply.status(401).send({
      error: {
        message: 'Invalid API key format. Keys must start with "sk-proxy-"',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_api_key',
      },
    });
    return;
  }

  const db = getDatabase();
  const keyHash = hashApiKey(apiKey);

  const results = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.enabled, true)))
    .limit(1);

  const keyRecord = results[0];

  if (!keyRecord) {
    reply.status(401).send({
      error: {
        message: 'Invalid API key.',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_api_key',
      },
    });
    return;
  }

  // 만료 체크
  if (keyRecord.expiresAt && new Date(keyRecord.expiresAt) < new Date()) {
    reply.status(401).send({
      error: {
        message: 'API key has expired.',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_api_key',
      },
    });
    return;
  }

  // 마지막 사용 시간 업데이트
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(apiKeys.id, keyRecord.id));

  // 요청에 키 정보 첨부
  (request as FastifyRequest & { apiKeyId?: string; apiKeyRateLimits?: { rpm?: number; rpd?: number } }).apiKeyId = keyRecord.id;
  (request as FastifyRequest & { apiKeyRateLimits?: { rpm?: number | null; rpd?: number | null } }).apiKeyRateLimits = {
    rpm: keyRecord.rateLimitRpm,
    rpd: keyRecord.rateLimitRpd,
  };
}

// Admin API 인증
export async function adminAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
  adminToken: string,
): Promise<void> {
  // localhost에서의 접근은 허용
  const remoteAddress = request.ip;
  if (remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1') {
    return;
  }

  const token = request.headers['x-admin-token'] as string | undefined;
  if (!token || token !== adminToken) {
    reply.status(403).send({
      error: {
        message: 'Forbidden. Admin token required.',
        type: 'invalid_request_error',
        param: null,
        code: 'forbidden',
      },
    });
  }
}
