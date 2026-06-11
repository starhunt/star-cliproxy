import { describe, it, expect, afterEach } from 'vitest';
import type { RateLimitConfig } from '@star-cliproxy/shared';
import { RateLimiter } from './rate-limiter.js';

// getDatabase()는 테스트 환경에서 미초기화 상태이며 loadFromDb/flushToDb가
// 내부 try-catch로 모든 에러를 삼키므로 인메모리 카운터만으로 동작한다.

function makeConfig(overrides?: Partial<RateLimitConfig>): RateLimitConfig {
  return {
    global: { rpm: 1000, rpd: 10000 },
    perProvider: {},
    ...overrides,
  };
}

const limiters: RateLimiter[] = [];
function newLimiter(config: RateLimitConfig): RateLimiter {
  const rl = new RateLimiter(config);
  limiters.push(rl);
  return rl;
}

afterEach(async () => {
  // cleanup 타이머 정리 (프로세스 유지 방지)
  await Promise.all(limiters.splice(0).map((rl) => rl.destroy()));
});

describe('RateLimiter - 폴백 중복 카운트 방지 (HIGH 버그 회귀)', () => {
  it('checkGlobalAndKey + checkProvider 분리: 폴백으로 프로바이더를 여러 번 시도해도 글로벌은 1회만 차감', () => {
    // 글로벌 RPM을 2로 제한. 한 요청이 2개 프로바이더로 폴백하는 상황을 시뮬레이션.
    const rl = newLimiter(makeConfig({ global: { rpm: 2, rpd: 100 } }));

    // 요청당 글로벌은 1회만 차감
    expect(rl.checkGlobalAndKey('key1').allowed).toBe(true);
    // 같은 요청 내에서 프로바이더 A, B를 시도 (글로벌 재차감 없음)
    expect(rl.checkProvider('providerA').allowed).toBe(true);
    expect(rl.checkProvider('providerB').allowed).toBe(true);

    // 글로벌은 아직 1만 소진 → 두 번째 요청도 통과해야 함
    expect(rl.checkGlobalAndKey('key1').allowed).toBe(true);
    // 세 번째 요청은 글로벌 RPM(2) 초과 → 차단
    const third = rl.checkGlobalAndKey('key1');
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('레거시 checkAndIncrement는 폴백 시 글로벌을 매번 차감(중복) — 분리 메서드로 교체된 이유', () => {
    const rl = newLimiter(makeConfig({ global: { rpm: 2, rpd: 100 } }));
    // checkAndIncrement는 글로벌+프로바이더를 한 번에 차감하므로
    // 폴백 루프 안에서 2회 호출하면 글로벌이 2 소진된다.
    expect(rl.checkAndIncrement('key1', 'providerA').allowed).toBe(true);
    expect(rl.checkAndIncrement('key1', 'providerB').allowed).toBe(true);
    // 글로벌 RPM(2) 이미 소진 → 다음 요청 차단 (단일 요청이 2슬롯을 먹은 셈)
    expect(rl.checkGlobalAndKey('key1').allowed).toBe(false);
  });
});

describe('RateLimiter - checkProvider', () => {
  it('프로바이더 한도가 없으면 항상 allowed', () => {
    const rl = newLimiter(makeConfig());
    for (let i = 0; i < 100; i++) {
      expect(rl.checkProvider('noLimit').allowed).toBe(true);
    }
  });

  it('프로바이더 RPM 한도 초과 시 차단 + retryAfter', () => {
    const rl = newLimiter(makeConfig({ perProvider: { gemini: { rpm: 2 } } }));
    expect(rl.checkProvider('gemini').allowed).toBe(true);
    expect(rl.checkProvider('gemini').allowed).toBe(true);
    const blocked = rl.checkProvider('gemini');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    // 다른 프로바이더는 독립 카운터
    expect(rl.checkProvider('other').allowed).toBe(true);
  });
});

describe('RateLimiter - checkGlobalAndKey', () => {
  it('글로벌 RPD 초과 시 글로벌 RPM 롤백 (원자성)', () => {
    // RPM은 넉넉, RPD를 1로 제한
    const rl = newLimiter(makeConfig({ global: { rpm: 100, rpd: 1 } }));
    expect(rl.checkGlobalAndKey('key1').allowed).toBe(true);
    // 두 번째: RPD(1) 초과 → 차단, 이때 RPM은 롤백되어야 함
    expect(rl.checkGlobalAndKey('key1').allowed).toBe(false);
  });

  it('API 키별 RPM 한도 적용 + 키별 독립', () => {
    const rl = newLimiter(makeConfig());
    expect(rl.checkGlobalAndKey('key1', { rpm: 1 }).allowed).toBe(true);
    expect(rl.checkGlobalAndKey('key1', { rpm: 1 }).allowed).toBe(false); // key1 초과
    expect(rl.checkGlobalAndKey('key2', { rpm: 1 }).allowed).toBe(true);  // key2는 독립
  });

  it('키 RPM 초과 시 글로벌 카운터 롤백', () => {
    const rl = newLimiter(makeConfig({ global: { rpm: 5, rpd: 5 } }));
    // key1: rpm 1 한도. 1회 통과 후 2회차 차단되며 글로벌은 롤백.
    expect(rl.checkGlobalAndKey('key1', { rpm: 1 }).allowed).toBe(true);  // global=1
    expect(rl.checkGlobalAndKey('key1', { rpm: 1 }).allowed).toBe(false); // key 초과, global 롤백
    // 글로벌이 롤백되었으므로 다른 키로 4회 더 통과 가능 (총 global 한도 5)
    for (let i = 0; i < 4; i++) {
      expect(rl.checkGlobalAndKey(`k${i}`).allowed).toBe(true);
    }
    expect(rl.checkGlobalAndKey('kX').allowed).toBe(false); // 이제 global 5 소진
  });
});
