import type { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/client.js';
import { providerHealth } from '../../db/schema.js';
import type { ProviderName } from '@star-cliproxy/shared';
import type { HealthChecker } from '../../services/health-checker.js';
import type { QueueManager } from '../../services/queue.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';

interface ProviderDeps {
  registry: ProviderRegistry;
  healthChecker: HealthChecker;
  queueManager: QueueManager;
}

export function registerProvidersRoutes(app: FastifyInstance, deps: ProviderDeps): void {
  // Provider 목록 + 상태
  app.get('/admin/providers', async (_request, reply) => {
    const db = getDatabase();
    const healthData = await db.select().from(providerHealth);
    const healthMap = new Map(healthData.map((h) => [h.provider, h]));

    const providers = deps.registry.getAll().map((p) => {
      const health = healthMap.get(p.name);
      const queueStatus = deps.queueManager.getStatus(p.name);

      return {
        name: p.name,
        status: health?.status ?? 'unknown',
        lastCheckAt: health?.lastCheckAt,
        lastSuccessAt: health?.lastSuccessAt,
        consecutiveFailures: health?.consecutiveFailures ?? 0,
        queue: queueStatus,
      };
    });

    return reply.send(providers);
  });

  // 수동 건강 체크
  app.post<{ Params: { name: string } }>('/admin/providers/:name/health-check', async (request, reply) => {
    const { name } = request.params;
    const providerName = name as ProviderName;

    if (!deps.registry.has(providerName)) {
      return reply.status(404).send({ error: { message: `Provider "${name}" not found.` } });
    }

    const status = await deps.healthChecker.checkProvider(providerName);
    return reply.send({ provider: name, status });
  });
}
