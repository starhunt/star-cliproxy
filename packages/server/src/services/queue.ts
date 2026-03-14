import PQueue from 'p-queue';
import type { ProviderName } from '@star-cliproxy/shared';

export interface QueueStatus {
  pending: number;
  size: number;
  concurrency: number;
}

export class QueueManager {
  private queues = new Map<ProviderName, PQueue>();

  addQueue(provider: ProviderName, concurrency: number): void {
    this.queues.set(provider, new PQueue({ concurrency }));
  }

  async enqueue<T>(
    provider: ProviderName,
    fn: () => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    const queue = this.queues.get(provider);
    if (!queue) {
      // 큐가 없으면 직접 실행
      return fn();
    }

    return queue.add(fn, {
      timeout: timeoutMs,
      throwOnTimeout: true,
    }) as Promise<T>;
  }

  getStatus(provider: ProviderName): QueueStatus | null {
    const queue = this.queues.get(provider);
    if (!queue) return null;

    return {
      pending: queue.pending,
      size: queue.size,
      concurrency: queue.concurrency,
    };
  }

  getAllStatus(): Record<string, QueueStatus> {
    const result: Record<string, QueueStatus> = {};
    for (const [name, queue] of this.queues) {
      result[name] = {
        pending: queue.pending,
        size: queue.size,
        concurrency: queue.concurrency,
      };
    }
    return result;
  }
}
