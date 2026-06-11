// KeyedMutex 단위 테스트

import { describe, it, expect } from 'vitest';
import { KeyedMutex } from './keyed-mutex.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('KeyedMutex', () => {
  it('같은 키의 작업은 FIFO 순서로 직렬화된다', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    await Promise.all([
      mutex.runExclusive('k', async () => {
        order.push('a-start');
        await delay(10);
        order.push('a-end');
      }),
      mutex.runExclusive('k', async () => {
        order.push('b-start');
        await delay(5);
        order.push('b-end');
      }),
      mutex.runExclusive('k', async () => {
        order.push('c-start');
        order.push('c-end');
      }),
    ]);

    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end', 'c-start', 'c-end']);
  });

  it('다른 키의 작업은 병렬 실행된다', async () => {
    const mutex = new KeyedMutex();
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = () =>
      (async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await delay(10);
        concurrent--;
      })();

    await Promise.all([
      mutex.runExclusive('k1', task),
      mutex.runExclusive('k2', task),
    ]);

    expect(maxConcurrent).toBe(2);
  });

  it('작업이 throw해도 락이 해제되어 다음 작업이 진행된다', async () => {
    const mutex = new KeyedMutex();

    await expect(
      mutex.runExclusive('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // 락이 해제되었으면 다음 작업이 즉시 실행 가능
    const result = await mutex.runExclusive('k', async () => 'ok');
    expect(result).toBe('ok');
  });

  it('acquire의 해제 함수는 멱등이다', async () => {
    const mutex = new KeyedMutex();

    const release = await mutex.acquire('k');
    release();
    release(); // 중복 호출해도 부작용 없음

    const result = await mutex.runExclusive('k', async () => 'ok');
    expect(result).toBe('ok');
  });
});
