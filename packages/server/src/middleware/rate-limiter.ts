import type { RateLimitConfig, ProviderName } from '@star-cliproxy/shared';

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
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  updateConfig(config: RateLimitConfig) {
    this.config = config;
  }

  destroy() {
    clearInterval(this.cleanupTimer);
  }

  // 요청 가능 여부 확인 + 카운터 원자적 증가
  checkAndIncrement(
    apiKeyId: string,
    provider: ProviderName,
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
  }
}
