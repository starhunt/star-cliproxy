import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodexCliSessionManager } from './codex-cli-session-manager.js';

describe('CodexCliSessionManager', () => {
  let manager: CodexCliSessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new CodexCliSessionManager(1000); // 1s TTL for test
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  it('set 후 동일 clientKey+model로 get하면 세션 반환', () => {
    manager.set('client-1', 'thread-abc', 'gpt-5.5');
    const session = manager.get('client-1', 'gpt-5.5');
    expect(session?.threadId).toBe('thread-abc');
    expect(session?.model).toBe('gpt-5.5');
  });

  it('미등록 clientKey는 null 반환', () => {
    expect(manager.get('unknown', 'gpt-5.5')).toBeNull();
  });

  it('TTL 초과 시 null 반환 + 자동 삭제', () => {
    manager.set('client-1', 'thread-abc', 'gpt-5.5');
    vi.advanceTimersByTime(1500); // 1.5s, TTL 초과
    expect(manager.get('client-1', 'gpt-5.5')).toBeNull();
    expect(manager.size).toBe(0);
  });

  it('모델이 다르면 세션 무효화 + null 반환', () => {
    manager.set('client-1', 'thread-abc', 'gpt-5.5');
    expect(manager.get('client-1', 'gpt-4o')).toBeNull();
    // 이후 같은 모델로도 안 됨 (무효화됨)
    expect(manager.get('client-1', 'gpt-5.5')).toBeNull();
  });

  it('get 시 lastUsedAt 갱신 → TTL 연장', () => {
    manager.set('client-1', 'thread-abc', 'gpt-5.5');
    vi.advanceTimersByTime(700);
    expect(manager.get('client-1', 'gpt-5.5')).not.toBeNull(); // 갱신
    vi.advanceTimersByTime(700); // 누적 1.4s지만 직전 get으로 갱신됨
    expect(manager.get('client-1', 'gpt-5.5')).not.toBeNull();
  });

  it('invalidate는 세션을 즉시 삭제', () => {
    manager.set('client-1', 'thread-abc', 'gpt-5.5');
    manager.invalidate('client-1');
    expect(manager.get('client-1', 'gpt-5.5')).toBeNull();
  });

  it('동일 clientKey에 set 재호출 시 thread_id 교체', () => {
    manager.set('client-1', 'thread-old', 'gpt-5.5');
    manager.set('client-1', 'thread-new', 'gpt-5.5');
    const session = manager.get('client-1', 'gpt-5.5');
    expect(session?.threadId).toBe('thread-new');
  });

  it('서로 다른 clientKey는 격리됨', () => {
    manager.set('client-1', 'thread-a', 'gpt-5.5');
    manager.set('client-2', 'thread-b', 'gpt-5.5');
    expect(manager.get('client-1', 'gpt-5.5')?.threadId).toBe('thread-a');
    expect(manager.get('client-2', 'gpt-5.5')?.threadId).toBe('thread-b');
  });

  it('destroy 후에는 size 0', () => {
    manager.set('client-1', 'thread-abc', 'gpt-5.5');
    manager.destroy();
    expect(manager.size).toBe(0);
  });
});
