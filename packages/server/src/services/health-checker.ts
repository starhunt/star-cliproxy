import { eq } from 'drizzle-orm';
import type { ProviderName, HealthStatus } from '@star-cliproxy/shared';
import { getDatabase } from '../db/client.js';
import { providerHealth } from '../db/schema.js';
import type { ProviderRegistry } from '../providers/provider-registry.js';

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

    const status = await provider.checkHealth();
    await this.updateHealth(name, status);
    return status;
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
