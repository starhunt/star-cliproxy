// Codex App Server 스레드 생명주기 관리
// Claude SDK의 SessionManager 패턴 적용: 클라이언트별 thread 추적, TTL 기반 자동 정리

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000; // 30분
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1분마다 만료 스레드 정리

export interface AppServerThread {
  threadId: string;
  model: string;
  lastUsedAt: number;
  ttlMs: number;
}

export class CodexAppServerSessionManager {
  private threads = new Map<string, AppServerThread>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private defaultTtlMs: number;

  constructor(defaultTtlMs = DEFAULT_SESSION_TTL_MS) {
    this.defaultTtlMs = defaultTtlMs;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Node.js 종료 시 타이머가 프로세스를 잡아두지 않도록 unref
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  // 클라이언트 키 + 모델로 스레드 조회
  // 모델이 다르면 기존 스레드 무효화 후 null 반환
  get(clientKey: string, model: string): AppServerThread | null {
    const thread = this.threads.get(clientKey);
    if (!thread) return null;

    // TTL 만료 확인
    if (Date.now() - thread.lastUsedAt > thread.ttlMs) {
      this.threads.delete(clientKey);
      return null;
    }

    // 모델 변경 시 스레드 무효화
    if (thread.model !== model) {
      this.threads.delete(clientKey);
      return null;
    }

    // 사용 시각 갱신
    thread.lastUsedAt = Date.now();
    return thread;
  }

  // 스레드 등록 (App Server 응답의 thread_id 캡처 후 호출)
  set(clientKey: string, threadId: string, model: string): void {
    this.threads.set(clientKey, {
      threadId,
      model,
      lastUsedAt: Date.now(),
      ttlMs: this.defaultTtlMs,
    });
  }

  // 스레드 무효화 (에러, 크래시 시)
  invalidate(clientKey: string): void {
    this.threads.delete(clientKey);
  }

  // 만료 스레드 정리
  private cleanup(): void {
    const now = Date.now();
    for (const [key, thread] of this.threads) {
      if (now - thread.lastUsedAt > thread.ttlMs) {
        this.threads.delete(key);
      }
    }
  }

  // 전체 스레드 수
  get size(): number {
    return this.threads.size;
  }

  // 리소스 해제
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.threads.clear();
  }
}
