import type { ReasoningEffort } from '@star-cliproxy/shared';

// 현재 처리 중인 요청을 인메모리로 추적
export interface ActiveRequest {
  requestId: string;
  modelAlias: string;
  provider: string;
  actualModel: string;
  reasoningEffort?: ReasoningEffort;
  isStream: boolean;
  startedAt: number; // Date.now()
}

export class ActiveRequestTracker {
  private requests = new Map<string, ActiveRequest>();

  start(req: ActiveRequest): void {
    this.requests.set(req.requestId, req);
  }

  finish(requestId: string): void {
    this.requests.delete(requestId);
  }

  getAll(): Array<ActiveRequest & { elapsedMs: number }> {
    const now = Date.now();
    return Array.from(this.requests.values())
      .map((r) => ({ ...r, elapsedMs: now - r.startedAt }))
      .sort((a, b) => b.elapsedMs - a.elapsedMs);
  }

  count(): number {
    return this.requests.size;
  }
}
