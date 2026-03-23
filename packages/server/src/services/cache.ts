import { createHash } from 'node:crypto';
import { eq, asc, lte, count } from 'drizzle-orm';
import type { CacheConfig, ChatMessage } from '@star-cliproxy/shared';
import { getDatabase } from '../db/client.js';
import { responseCache } from '../db/schema.js';

// 캐시 조회 결과 타입
export interface CachedResponse {
  responseBody: string;
  tokenCount: number | null;
  provider: string;
  modelAlias: string;
}

export class ResponseCache {
  private config: CacheConfig;

  constructor(config: CacheConfig) {
    this.config = config;
  }

  // SHA-256(modelAlias + JSON.stringify(messages)) 으로 해시 키 생성
  generateHash(modelAlias: string, messages: ChatMessage[]): string {
    const payload = modelAlias + JSON.stringify(messages);
    return createHash('sha256').update(payload).digest('hex');
  }

  // 캐시 조회: 해시로 조회, 만료 확인, 없거나 만료면 null
  async get(requestHash: string): Promise<CachedResponse | null> {
    if (!this.config.enabled) return null;

    try {
      const db = getDatabase();
      const rows = await db
        .select()
        .from(responseCache)
        .where(eq(responseCache.requestHash, requestHash))
        .limit(1);

      if (rows.length === 0) return null;

      const row = rows[0];

      // 만료 확인
      const now = new Date().toISOString();
      if (row.expiresAt <= now) {
        // 만료된 항목 삭제
        await db.delete(responseCache).where(eq(responseCache.requestHash, requestHash));
        return null;
      }

      return {
        responseBody: row.responseBody,
        tokenCount: row.tokenCount,
        provider: row.provider,
        modelAlias: row.modelAlias,
      };
    } catch (err) {
      // 캐시 실패가 요청을 중단시키지 않도록
      console.error('Cache get failed:', err);
      return null;
    }
  }

  // 캐시 저장: maxEntries 초과 시 가장 오래된 항목 삭제
  async set(
    requestHash: string,
    modelAlias: string,
    provider: string,
    responseBody: string,
    tokenCount?: number,
  ): Promise<void> {
    if (!this.config.enabled) return;

    try {
      const db = getDatabase();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.config.ttlSeconds * 1000);

      // count → delete → insert를 단일 트랜잭션으로 묶어 원자성 보장
      // (better-sqlite3 드라이버는 동기 트랜잭션을 사용)
      db.transaction((tx) => {
        // maxEntries 초과 시 가장 오래된 항목 삭제
        const countResult = tx.select({ value: count() }).from(responseCache).all();
        const currentCount = (countResult[0]?.value ?? 0) as number;

        if (currentCount >= this.config.maxEntries) {
          // 삭제할 항목 수: 새 항목 삽입 후 maxEntries 이하가 되도록
          const deleteCount = currentCount - this.config.maxEntries + 1;
          const oldest = tx
            .select({ requestHash: responseCache.requestHash })
            .from(responseCache)
            .orderBy(asc(responseCache.createdAt))
            .limit(deleteCount)
            .all();

          for (const row of oldest) {
            tx.delete(responseCache).where(eq(responseCache.requestHash, row.requestHash)).run();
          }
        }

        // upsert: 같은 해시가 있으면 덮어쓰기
        tx
          .insert(responseCache)
          .values({
            requestHash,
            modelAlias,
            provider,
            responseBody,
            tokenCount: tokenCount ?? null,
            createdAt: now.toISOString(),
            expiresAt: expiresAt.toISOString(),
          })
          .onConflictDoUpdate({
            target: responseCache.requestHash,
            set: {
              responseBody,
              tokenCount: tokenCount ?? null,
              createdAt: now.toISOString(),
              expiresAt: expiresAt.toISOString(),
            },
          })
          .run();
      });
    } catch (err) {
      // 캐시 실패가 요청을 중단시키지 않도록
      console.error('Cache set failed:', err);
    }
  }

  // 만료된 캐시 정리 (주기적)
  async cleanup(): Promise<number> {
    try {
      const db = getDatabase();
      const now = new Date().toISOString();

      // 만료된 항목 수 조회
      const expiredCount = await db
        .select({ value: count() })
        .from(responseCache)
        .where(lte(responseCache.expiresAt, now));

      const deletedCount = expiredCount[0]?.value ?? 0;

      // 만료된 항목 삭제
      if (deletedCount > 0) {
        await db.delete(responseCache).where(lte(responseCache.expiresAt, now));
      }

      return deletedCount;
    } catch (err) {
      console.error('Cache cleanup failed:', err);
      return 0;
    }
  }

  // 캐시 통계 (대시보드용)
  async getStats(): Promise<{ count: number; oldestAt: string | null }> {
    try {
      const db = getDatabase();

      const countResult = await db.select({ value: count() }).from(responseCache);
      const totalCount = countResult[0]?.value ?? 0;

      let oldestAt: string | null = null;
      if (totalCount > 0) {
        const oldest = await db
          .select({ createdAt: responseCache.createdAt })
          .from(responseCache)
          .orderBy(asc(responseCache.createdAt))
          .limit(1);
        oldestAt = oldest[0]?.createdAt ?? null;
      }

      return { count: totalCount, oldestAt };
    } catch (err) {
      console.error('Cache getStats failed:', err);
      return { count: 0, oldestAt: null };
    }
  }
}
