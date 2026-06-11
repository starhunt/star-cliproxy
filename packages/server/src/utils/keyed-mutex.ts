// 키 단위 비동기 뮤텍스
// 같은 키의 작업은 FIFO 직렬화, 다른 키는 병렬 허용.
// codex app-server thread당 turn 직렬화(#24)에 사용.

export class KeyedMutex {
  // 키별 대기 체인의 꼬리. 새 작업은 이전 꼬리가 해소된 뒤 진입한다.
  private tails = new Map<string, Promise<void>>();

  // 락 획득. 반환된 함수를 호출하면 해제된다 (멱등).
  // 호출 측은 반드시 try/finally로 해제를 보장할 것.
  async acquire(key: string): Promise<() => void> {
    const prev = this.tails.get(key) ?? Promise.resolve();

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const tail = prev.then(() => gate);
    this.tails.set(key, tail);

    await prev;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
      // 내 뒤에 대기자가 없으면 맵에서 제거 (메모리 누수 방지)
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    };
  }

  // 락을 잡고 fn 실행 후 자동 해제
  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
