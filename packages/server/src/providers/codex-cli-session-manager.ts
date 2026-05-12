// Codex CLI (exec resume) 세션 매니저
// codex exec --json 첫 호출에서 캡처한 thread_id를 clientKey별로 보관 → 후속 호출이 exec resume <id>로 자동 분기.
// 같은 패턴: CodexAppServerSessionManager / ClaudeSdkSessionManager.

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000; // 30분
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1분마다 만료 세션 정리

export interface CliSession {
  threadId: string;
  model: string;
  lastUsedAt: number;
  ttlMs: number;
}

export class CodexCliSessionManager {
  private sessions = new Map<string, CliSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private defaultTtlMs: number;

  constructor(defaultTtlMs = DEFAULT_SESSION_TTL_MS) {
    this.defaultTtlMs = defaultTtlMs;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  // clientKey + 모델로 세션 조회. 모델이 다르면 기존 세션을 무효화 후 null 반환.
  get(clientKey: string, model: string): CliSession | null {
    const session = this.sessions.get(clientKey);
    if (!session) return null;

    if (Date.now() - session.lastUsedAt > session.ttlMs) {
      this.sessions.delete(clientKey);
      return null;
    }

    if (session.model !== model) {
      this.sessions.delete(clientKey);
      return null;
    }

    session.lastUsedAt = Date.now();
    return session;
  }

  // thread_id 캡처 후 등록. 이미 존재하면 갱신(thread_id가 바뀌었을 수 있음).
  set(clientKey: string, threadId: string, model: string): void {
    this.sessions.set(clientKey, {
      threadId,
      model,
      lastUsedAt: Date.now(),
      ttlMs: this.defaultTtlMs,
    });
  }

  // 에러/타임아웃 시 무효화.
  invalidate(clientKey: string): void {
    this.sessions.delete(clientKey);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastUsedAt > session.ttlMs) {
        this.sessions.delete(key);
      }
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }
}
