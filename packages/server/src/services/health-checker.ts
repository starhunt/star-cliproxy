import { eq, desc } from 'drizzle-orm';
import type { ProviderName, HealthStatus } from '@star-cliproxy/shared';
import { getDatabase } from '../db/client.js';
import { providerHealth, requestLogs } from '../db/schema.js';
import type { ProviderRegistry } from '../providers/provider-registry.js';

// 최근 요청 기반 건강 판정 임계값
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30분
const RECENT_CHECK_COUNT = 3;
const ERROR_THRESHOLD = 2;

const MAX_CONSECUTIVE_FAILURES = 3;

export class HealthChecker {
  private registry: ProviderRegistry;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(registry: ProviderRegistry) {
    this.registry = registry;
  }

  // 주기적 건강 체크 시작
  start(intervalMs: number = 60_000): void {
    this.checkAll(); // 즉시 1회 실행
    this.intervalId = setInterval(() => this.checkAll(), intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async checkAll(): Promise<void> {
    const providers = this.registry.getAll();
    await Promise.allSettled(
      providers.map((p) => this.checkProvider(p.name)),
    );
  }

  async checkProvider(name: ProviderName): Promise<HealthStatus> {
    const provider = this.registry.get(name);
    if (!provider) return 'unknown';

    // 1단계: CLI --version 체크
    const cliStatus = await provider.checkHealth();

    // 2단계: CLI 실패면 즉시 unhealthy
    if (cliStatus === 'unhealthy') {
      await this.updateHealth(name, cliStatus);
      return cliStatus;
    }

    // 3단계: CLI 성공 후, 최근 요청 이력 기반 추가 판정
    const recentHealthy = await this.checkRecentRequests(name);
    const finalStatus: HealthStatus = recentHealthy ? 'healthy' : 'unhealthy';

    await this.updateHealth(name, finalStatus);
    return finalStatus;
  }

  // 최근 요청 기반 건강 판정
  // 마지막 성공 요청이 30분 이상 경과 + 최근 3건 중 에러 2건 이상 → unhealthy
  // 요청 이력이 없으면 (서버 시작 직후) → healthy (CLI 결과만 사용)
  private async checkRecentRequests(provider: ProviderName): Promise<boolean> {
    try {
      const db = getDatabase();

      // 해당 provider의 최근 3건 조회
      const recentLogs = await db
        .select({
          status: requestLogs.status,
          createdAt: requestLogs.createdAt,
        })
        .from(requestLogs)
        .where(eq(requestLogs.provider, provider))
        .orderBy(desc(requestLogs.createdAt))
        .limit(RECENT_CHECK_COUNT);

      // 요청 이력이 없으면 CLI 결과만 사용 (healthy)
      if (recentLogs.length === 0) {
        return true;
      }

      // 마지막 성공 요청 시간 확인
      const lastSuccess = recentLogs.find((log) => log.status === 'success');
      const now = Date.now();

      if (lastSuccess) {
        const lastSuccessTime = new Date(lastSuccess.createdAt).getTime();
        const elapsed = now - lastSuccessTime;

        // 30분 이내에 성공이 있으면 healthy
        if (elapsed < STALE_THRESHOLD_MS) {
          return true;
        }
      }

      // 마지막 성공이 30분 이상 경과 (또는 성공 없음): 에러 비율 확인
      const errorCount = recentLogs.filter(
        (log) => log.status === 'error' || log.status === 'timeout',
      ).length;

      // 최근 3건 중 에러가 2건 이상이면 unhealthy
      return errorCount < ERROR_THRESHOLD;
    } catch {
      // DB 조회 실패 시 CLI 결과만 사용 (healthy)
      return true;
    }
  }

  async getHealth(name: ProviderName): Promise<HealthStatus> {
    const db = getDatabase();
    const results = await db
      .select()
      .from(providerHealth)
      .where(eq(providerHealth.provider, name))
      .limit(1);

    return (results[0]?.status as HealthStatus) ?? 'unknown';
  }

  async isHealthy(name: ProviderName): Promise<boolean> {
    const status = await this.getHealth(name);
    // unknown도 시도 허용 (첫 실행 시)
    return status !== 'unhealthy';
  }

  private async updateHealth(name: ProviderName, status: HealthStatus): Promise<void> {
    const db = getDatabase();
    const now = new Date().toISOString();

    const existing = await db
      .select()
      .from(providerHealth)
      .where(eq(providerHealth.provider, name))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(providerHealth).values({
        provider: name,
        status,
        lastCheckAt: now,
        lastSuccessAt: status === 'healthy' ? now : null,
        consecutiveFailures: status === 'healthy' ? 0 : 1,
      });
    } else {
      const prev = existing[0];
      const failures = status === 'healthy' ? 0 : (prev.consecutiveFailures + 1);
      const effectiveStatus = failures >= MAX_CONSECUTIVE_FAILURES ? 'unhealthy' : status;

      await db
        .update(providerHealth)
        .set({
          status: effectiveStatus,
          lastCheckAt: now,
          lastSuccessAt: status === 'healthy' ? now : prev.lastSuccessAt,
          consecutiveFailures: failures,
          errorMessage: status === 'unhealthy' ? `Health check failed` : null,
        })
        .where(eq(providerHealth.provider, name));
    }
  }
}
