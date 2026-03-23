import { eq, like } from 'drizzle-orm';
import type { RateLimitConfig } from '@star-cliproxy/shared';
import { getDatabase } from '../db/client.js';
import { settings } from '../db/schema.js';

const RATE_LIMIT_PREFIX = 'rate_limit:';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// 인메모리 슬라이딩 윈도우 레이트 리미터
export class RateLimiter {
  private minuteCounters = new Map<string, RateLimitEntry>();
  private dayCounters = new Map<string, RateLimitEntry>();
  private config: RateLimitConfig;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(config: RateLimitConfig) {
    this.config = config;
    // DB에서 기존 카운터 복원
    this.loadFromDb().catch((err) => {
      // DB 로드 실패해도 레이트 리미팅은 정상 동작
      console.warn('[rate-limiter] loadFromDb failed:', err);
    });
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  updateConfig(config: RateLimitConfig) {
    this.config = config;
  }

  async destroy() {
    clearInterval(this.cleanupTimer);
    // 종료 시 최종 flush
    await this.flushToDb();
  }

  // 요청 가능 여부 확인 + 카운터 원자적 증가
  checkAndIncrement(
    apiKeyId: string,
    provider: string,
    keyLimits?: { rpm?: number | null; rpd?: number | null },
  ): { allowed: boolean; retryAfterSeconds?: number } {
    const now = Date.now();

    // 1. 글로벌 RPM
    const globalRpm = this.tryIncrement('global:rpm', this.config.global.rpm, now, 60_000, this.minuteCounters);
    if (!globalRpm.allowed) return globalRpm;

    // 2. 글로벌 RPD
    const globalRpd = this.tryIncrement('global:rpd', this.config.global.rpd, now, 86_400_000, this.dayCounters);
    if (!globalRpd.allowed) {
      this.rollback('global:rpm', this.minuteCounters);
      return globalRpd;
    }

    // 3. Provider별 RPM
    const providerLimit = this.config.perProvider[provider]?.rpm;
    if (providerLimit) {
      const providerRpm = this.tryIncrement(`provider:${provider}:rpm`, providerLimit, now, 60_000, this.minuteCounters);
      if (!providerRpm.allowed) {
        this.rollback('global:rpm', this.minuteCounters);
        this.rollback('global:rpd', this.dayCounters);
        return providerRpm;
      }
    }

    // 4. API 키별 RPM
    if (keyLimits?.rpm) {
      const keyRpm = this.tryIncrement(`key:${apiKeyId}:rpm`, keyLimits.rpm, now, 60_000, this.minuteCounters);
      if (!keyRpm.allowed) {
        this.rollback('global:rpm', this.minuteCounters);
        this.rollback('global:rpd', this.dayCounters);
        if (providerLimit) this.rollback(`provider:${provider}:rpm`, this.minuteCounters);
        return keyRpm;
      }
    }

    // 5. API 키별 RPD
    if (keyLimits?.rpd) {
      const keyRpd = this.tryIncrement(`key:${apiKeyId}:rpd`, keyLimits.rpd, now, 86_400_000, this.dayCounters);
      if (!keyRpd.allowed) {
        this.rollback('global:rpm', this.minuteCounters);
        this.rollback('global:rpd', this.dayCounters);
        if (providerLimit) this.rollback(`provider:${provider}:rpm`, this.minuteCounters);
        if (keyLimits.rpm) this.rollback(`key:${apiKeyId}:rpm`, this.minuteCounters);
        return keyRpd;
      }
    }

    return { allowed: true };
  }

  // 원자적 check + increment: 한도 내이면 즉시 카운터 증가
  private tryIncrement(
    key: string,
    limit: number,
    now: number,
    windowMs: number,
    counters: Map<string, RateLimitEntry>,
  ): { allowed: boolean; retryAfterSeconds?: number } {
    const entry = counters.get(key);

    if (!entry || now >= entry.resetAt) {
      counters.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true };
    }

    if (entry.count >= limit) {
      const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
      return { allowed: false, retryAfterSeconds };
    }

    entry.count++;
    return { allowed: true };
  }

  // 후속 체크 실패 시 이미 증가된 카운터를 되돌림
  private rollback(key: string, counters: Map<string, RateLimitEntry>): void {
    const entry = counters.get(key);
    if (entry && entry.count > 0) {
      entry.count--;
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.minuteCounters) {
      if (now >= entry.resetAt) this.minuteCounters.delete(key);
    }
    for (const [key, entry] of this.dayCounters) {
      if (now >= entry.resetAt) this.dayCounters.delete(key);
    }
    // cleanup 주기(1분)마다 DB에 flush
    this.flushToDb().catch((err) => {
      // DB flush 실패해도 레이트 리미팅은 정상 동작
      console.warn('[rate-limiter] flushToDb failed:', err);
    });
  }

  // DB에서 기존 카운터 복원
  private async loadFromDb(): Promise<void> {
    try {
      const db = getDatabase();
      const rows = await db
        .select()
        .from(settings)
        .where(like(settings.key, `${RATE_LIMIT_PREFIX}%`));

      const now = Date.now();
      for (const row of rows) {
        const counterKey = row.key.slice(RATE_LIMIT_PREFIX.length);
        try {
          const data = JSON.parse(row.value) as RateLimitEntry;
          // resetAt이 아직 유효한 항목만 복원
          if (data.resetAt > now) {
            // 윈도우 크기로 minute/day 카운터 구분
            // resetAt - now > 60초면 day 카운터
            const remainingMs = data.resetAt - now;
            if (remainingMs > 120_000) {
              this.dayCounters.set(counterKey, data);
            } else {
              this.minuteCounters.set(counterKey, data);
            }
          }
        } catch {
          // 파싱 실패한 항목은 무시
        }
      }
    } catch {
      // DB 접근 실패 시 인메모리 카운터로 시작
    }
  }

  // 현재 카운터를 DB에 저장
  private async flushToDb(): Promise<void> {
    try {
      const db = getDatabase();
      const now = Date.now();
      const nowIso = new Date().toISOString();

      // 유효한 카운터 수집
      const entries = new Map<string, RateLimitEntry>();
      for (const [key, entry] of this.minuteCounters) {
        if (now < entry.resetAt) entries.set(key, entry);
      }
      for (const [key, entry] of this.dayCounters) {
        if (now < entry.resetAt) entries.set(key, entry);
      }

      // 기존 rate_limit: 키 전부 조회
      const existingRows = await db
        .select({ key: settings.key })
        .from(settings)
        .where(like(settings.key, `${RATE_LIMIT_PREFIX}%`));

      const existingKeys = new Set(existingRows.map((r) => r.key));

      // upsert: 유효한 카운터 저장
      for (const [key, entry] of entries) {
        const dbKey = `${RATE_LIMIT_PREFIX}${key}`;
        const value = JSON.stringify(entry);

        if (existingKeys.has(dbKey)) {
          await db
            .update(settings)
            .set({ value, updatedAt: nowIso })
            .where(eq(settings.key, dbKey));
          existingKeys.delete(dbKey);
        } else {
          await db.insert(settings).values({
            key: dbKey,
            value,
            updatedAt: nowIso,
          });
        }
      }

      // 만료된 항목 삭제
      for (const staleKey of existingKeys) {
        await db.delete(settings).where(eq(settings.key, staleKey));
      }
    } catch {
      // DB 접근 실패가 레이트 리미팅을 중단시키지 않음
    }
  }
}
