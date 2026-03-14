import type { FastifyRequest, FastifyReply } from 'fastify';
import type { RateLimitConfig, ProviderName } from '@star-cliproxy/shared';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// 인메모리 슬라이딩 윈도우 레이트 리미터
export class RateLimiter {
  // key → RateLimitEntry
  private minuteCounters = new Map<string, RateLimitEntry>();
  private dayCounters = new Map<string, RateLimitEntry>();
  private config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;

    // 만료된 카운터 주기적으로 정리
    setInterval(() => this.cleanup(), 60_000);
  }

  updateConfig(config: RateLimitConfig) {
    this.config = config;
  }

  // 요청 가능 여부 확인 + 카운터 증가
  checkAndIncrement(
    apiKeyId: string,
    provider: ProviderName,
    keyLimits?: { rpm?: number | null; rpd?: number | null },
  ): { allowed: boolean; retryAfterSeconds?: number } {
    const now = Date.now();

    // 1. 글로벌 RPM 체크
    const globalRpmResult = this.checkCounter(
      `global:rpm`,
      this.config.global.rpm,
      now,
      60_000,
      this.minuteCounters,
    );
    if (!globalRpmResult.allowed) return globalRpmResult;

    // 2. 글로벌 RPD 체크
    const globalRpdResult = this.checkCounter(
      `global:rpd`,
      this.config.global.rpd,
      now,
      86_400_000,
      this.dayCounters,
    );
    if (!globalRpdResult.allowed) return globalRpdResult;

    // 3. Provider별 RPM 체크
    const providerLimit = this.config.perProvider[provider]?.rpm;
    if (providerLimit) {
      const providerResult = this.checkCounter(
        `provider:${provider}:rpm`,
        providerLimit,
        now,
        60_000,
        this.minuteCounters,
      );
      if (!providerResult.allowed) return providerResult;
    }

    // 4. API 키별 RPM 체크
    if (keyLimits?.rpm) {
      const keyRpmResult = this.checkCounter(
        `key:${apiKeyId}:rpm`,
        keyLimits.rpm,
        now,
        60_000,
        this.minuteCounters,
      );
      if (!keyRpmResult.allowed) return keyRpmResult;
    }

    // 5. API 키별 RPD 체크
    if (keyLimits?.rpd) {
      const keyRpdResult = this.checkCounter(
        `key:${apiKeyId}:rpd`,
        keyLimits.rpd,
        now,
        86_400_000,
        this.dayCounters,
      );
      if (!keyRpdResult.allowed) return keyRpdResult;
    }

    // 모든 체크 통과 → 카운터 증가
    this.increment(`global:rpm`, now, 60_000, this.minuteCounters);
    this.increment(`global:rpd`, now, 86_400_000, this.dayCounters);
    if (providerLimit) {
      this.increment(`provider:${provider}:rpm`, now, 60_000, this.minuteCounters);
    }
    if (keyLimits?.rpm) {
      this.increment(`key:${apiKeyId}:rpm`, now, 60_000, this.minuteCounters);
    }
    if (keyLimits?.rpd) {
      this.increment(`key:${apiKeyId}:rpd`, now, 86_400_000, this.dayCounters);
    }

    return { allowed: true };
  }

  private checkCounter(
    key: string,
    limit: number,
    now: number,
    windowMs: number,
    counters: Map<string, RateLimitEntry>,
  ): { allowed: boolean; retryAfterSeconds?: number } {
    const entry = counters.get(key);

    if (!entry || now >= entry.resetAt) {
      return { allowed: true };
    }

    if (entry.count >= limit) {
      const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
      return { allowed: false, retryAfterSeconds };
    }

    return { allowed: true };
  }

  private increment(
    key: string,
    now: number,
    windowMs: number,
    counters: Map<string, RateLimitEntry>,
  ): void {
    const entry = counters.get(key);

    if (!entry || now >= entry.resetAt) {
      counters.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count++;
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
  }
}
