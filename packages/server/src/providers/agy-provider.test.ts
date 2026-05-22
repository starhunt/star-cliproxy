import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecuteOptions, ProviderConfigYaml, ProviderEvent } from '@star-cliproxy/shared';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

// ESM 환경에서 export를 직접 spy할 수 없으므로 vi.mock 팩토리로 spawn 자체를 교체.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { spawn } from 'node:child_process';
import { AgyProvider } from './agy-provider.js';

const spawnMock = vi.mocked(spawn);

function baseConfig(extra: Partial<ProviderConfigYaml> = {}): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: 'agy',
    default_model: 'antigravity',
    max_concurrent: 1,
    timeout_ms: 30_000,
    extra_args: [],
    ...extra,
  };
}

function baseOptions(extra: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    model: 'antigravity',
    stream: false,
    ...extra,
  };
}

// child_process.spawn 모킹 — 실제 agy 바이너리 호출 없이 stdout/stderr/exitCode 시뮬레이션.
function fakeChild(stdout: string, stderr = '', exitCode = 0) {
  const child = new EventEmitter() as unknown as ReturnType<typeof spawn>;
  (child as unknown as { stdout: Readable }).stdout = Readable.from([Buffer.from(stdout)]);
  (child as unknown as { stderr: Readable }).stderr = Readable.from([Buffer.from(stderr)]);
  (child as unknown as { kill: (sig?: string) => boolean }).kill = vi.fn(() => true);
  (child as unknown as { killed: boolean }).killed = false;
  (child as unknown as { stdin: { end: () => void; write: () => void } }).stdin = { end: vi.fn(), write: vi.fn() };

  setImmediate(() => (child as unknown as EventEmitter).emit('close', exitCode));
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('AgyProvider.buildArgs', () => {
  it('messages를 -p 인수 1개로 직렬화', () => {
    const provider = new AgyProvider(baseConfig());
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions({ messages: [{ role: 'user', content: 'ping' }] }),
    );
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('ping');
  });

  it('-m/--model 플래그를 추가하지 않음 (1.0.0 미지원)', () => {
    const provider = new AgyProvider(baseConfig());
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions({ model: 'gemini-3-flash' }),
    );
    expect(args).not.toContain('-m');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('gemini-3-flash');
  });

  it('extra_args를 -p prompt 앞에 그대로 prepend', () => {
    const provider = new AgyProvider(baseConfig({
      extra_args: ['--dangerously-skip-permissions', '--sandbox'],
    }));
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions(),
    );
    expect(args).toEqual(['--dangerously-skip-permissions', '--sandbox', '-p', 'hello']);
  });

  it('800KB 초과 prompt는 빌드 단계에서 즉시 throw (ARG_MAX 보호)', () => {
    const provider = new AgyProvider(baseConfig());
    const huge = 'x'.repeat(800_001);
    expect(() =>
      (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
        baseOptions({ messages: [{ role: 'user', content: huge }] }),
      ),
    ).toThrow(/prompt exceeds/);
  });
});

describe('AgyProvider.execute (plain text 파싱)', () => {
  it('stdout을 trim한 plain text를 content로 반환', async () => {
    spawnMock.mockReturnValue(fakeChild('  Hello from agy.  \n'));
    const provider = new AgyProvider(baseConfig());
    const result = await provider.execute(baseOptions());
    expect(result.content).toBe('Hello from agy.');
    expect(result.finishReason).toBe('stop');
  });

  it('ANSI 색상 시퀀스를 스트립', async () => {
    spawnMock.mockReturnValue(fakeChild('\x1B[31mred\x1B[0m text'));
    const provider = new AgyProvider(baseConfig());
    const result = await provider.execute(baseOptions());
    expect(result.content).toBe('red text');
  });

  it('non-zero exit code는 stderr 메시지와 함께 throw', async () => {
    spawnMock.mockReturnValue(fakeChild('', 'auth required', 1));
    const provider = new AgyProvider(baseConfig());
    await expect(provider.execute(baseOptions())).rejects.toThrow(/auth required/);
  });

  it('토큰 사용량은 estimateTokens 폴백 (1.0.0이 토큰 정보 미제공)', async () => {
    spawnMock.mockReturnValue(fakeChild('1234567890'));
    const provider = new AgyProvider(baseConfig());
    const result = await provider.execute(baseOptions());
    // 10 chars → ceil(10/4) = 3 completion tokens
    expect(result.usage.completionTokens).toBe(3);
    expect(result.usage.promptTokens).toBe(0);
  });
});

describe('AgyProvider.executeStream (단일-청크 가짜 스트리밍)', () => {
  it('text_delta → usage → done 순서로 이벤트 emit', async () => {
    spawnMock.mockReturnValue(fakeChild('response body'));
    const provider = new AgyProvider(baseConfig());
    const events: ProviderEvent[] = [];
    for await (const ev of provider.executeStream(baseOptions({ stream: true }))) {
      events.push(ev);
    }

    expect(events.map(e => e.type)).toEqual(['text_delta', 'usage', 'done']);
    expect((events[0] as { type: 'text_delta'; text: string }).text).toBe('response body');
    expect((events[2] as { type: 'done'; finishReason: string }).finishReason).toBe('stop');
  });

  it('빈 응답은 text_delta를 emit하지 않음', async () => {
    spawnMock.mockReturnValue(fakeChild(''));
    const provider = new AgyProvider(baseConfig());
    const events: ProviderEvent[] = [];
    for await (const ev of provider.executeStream(baseOptions({ stream: true }))) {
      events.push(ev);
    }
    expect(events.map(e => e.type)).toEqual(['usage', 'done']);
  });
});
