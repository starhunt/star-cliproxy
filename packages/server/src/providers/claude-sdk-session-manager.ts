// Claude Agent SDK 세션 생명주기 관리
// Claudian의 SessionManager 패턴 참고: 클라이언트별 세션 추적, TTL 기반 자동 정리

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000; // 30분
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1분마다 만료 세션 정리

export interface SdkSession {
  sessionId: string;
  model: string;
  lastUsedAt: number;
  ttlMs: number;
}

export class ClaudeSdkSessionManager {
  private sessions = new Map<string, SdkSession>();
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

  // 클라이언트 키 + 모델로 세션 조회
  // 모델이 다르면 기존 세션 무효화 후 null 반환
  get(clientKey: string, model: string): SdkSession | null {
    const session = this.sessions.get(clientKey);
    if (!session) return null;

    // TTL 만료 확인
    if (Date.now() - session.lastUsedAt > session.ttlMs) {
      this.sessions.delete(clientKey);
      return null;
    }

    // 모델 변경 시 세션 무효화
    if (session.model !== model) {
      this.sessions.delete(clientKey);
      return null;
    }

    // 사용 시각 갱신
    session.lastUsedAt = Date.now();
    return session;
  }

  // 세션 등록 (SDK query 응답의 session_id 캡처 후 호출)
  set(clientKey: string, sessionId: string, model: string): void {
    this.sessions.set(clientKey, {
      sessionId,
      model,
      lastUsedAt: Date.now(),
      ttlMs: this.defaultTtlMs,
    });
  }

  // 세션 무효화 (에러, 크래시 시)
  invalidate(clientKey: string): void {
    this.sessions.delete(clientKey);
  }

  // 만료 세션 정리
  private cleanup(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastUsedAt > session.ttlMs) {
        this.sessions.delete(key);
      }
    }
  }

  // 전체 세션 수
  get size(): number {
    return this.sessions.size;
  }

  // 리소스 해제
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }
}
