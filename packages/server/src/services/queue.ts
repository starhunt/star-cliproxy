import PQueue from 'p-queue';
// ProviderName은 string 타입

export interface QueueStatus {
  pending: number;
  size: number;
  concurrency: number;
}

export class QueueManager {
  private queues = new Map<string, PQueue>();

  addQueue(provider: string, concurrency: number): void {
    this.queues.set(provider, new PQueue({ concurrency }));
  }

  async enqueue<T>(
    provider: string,
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

  getStatus(provider: string): QueueStatus | null {
    const queue = this.queues.get(provider);
    if (!queue) return null;

    return {
      pending: queue.pending,
      size: queue.size,
      concurrency: queue.concurrency,
    };
  }

  // 프로바이더 동시 처리 수 런타임 변경 (PQueue의 concurrency setter 사용)
  updateConcurrency(provider: string, concurrency: number): boolean {
    const queue = this.queues.get(provider);
    if (!queue) return false;
    queue.concurrency = concurrency;
    return true;
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
