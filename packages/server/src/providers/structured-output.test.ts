import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecuteOptions, ProviderConfigYaml, ProviderEvent } from '@star-cliproxy/shared';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from 'node:child_process';
import { ClaudeProvider } from './claude-provider.js';
import { CodexProvider } from './codex-provider.js';

const spawnMock = vi.mocked(spawn);

const jsonSchemaFormat = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'answer_shape',
    strict: true,
    schema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    },
  },
};

function config(cli: string, extra: Partial<ProviderConfigYaml> = {}): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: cli,
    default_model: cli === 'claude' ? 'claude-sonnet-4-6' : 'gpt-5.5',
    max_concurrent: 1,
    timeout_ms: 30_000,
    extra_args: [],
    ...extra,
  };
}

function options(extra: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    model: extra.model ?? 'claude-sonnet-4-6',
    stream: false,
    ...extra,
  };
}

// spawn이 호출된 시점에 child를 만든다. mockReturnValue(fakeChild(...))처럼 미리 만들면
// close를 알리는 setImmediate가 spawn 이전에 발화해, provider가 임시 파일 I/O 등으로
// 한 tick이라도 늦게 spawn할 때 close를 영영 못 받는다(codex 스키마 파일 경로).
function mockSpawn(stdout: string, stderr = '', exitCode = 0) {
  spawnMock.mockImplementation(() => fakeChild(stdout, stderr, exitCode));
}

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

type BuildArgs = { buildArgs(opts: ExecuteOptions): string[] };

describe('ClaudeProvider - structured output', () => {
  it('중첩 schema만 --json-schema로 전달 (CLI 모드)', () => {
    const provider = new ClaudeProvider(config('claude'));
    const args = (provider as unknown as BuildArgs).buildArgs(options({ chatResponseFormat: jsonSchemaFormat }));
    const idx = args.indexOf('--json-schema');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(args[idx + 1])).toEqual(jsonSchemaFormat.json_schema.schema);
  });

  it('json_object/text는 --json-schema를 추가하지 않음', () => {
    const provider = new ClaudeProvider(config('claude'));
    for (const format of [{ type: 'json_object' as const }, { type: 'text' as const }]) {
      const args = (provider as unknown as BuildArgs).buildArgs(options({ chatResponseFormat: format }));
      expect(args).not.toContain('--json-schema');
    }
  });

  it('extra_args에 --json-schema가 있으면 사용자 값 존중', () => {
    const provider = new ClaudeProvider(config('claude', { extra_args: ['--json-schema', '/etc/custom.json'] }));
    const args = (provider as unknown as BuildArgs).buildArgs(options({ chatResponseFormat: jsonSchemaFormat }));
    expect(args.filter((arg) => arg === '--json-schema')).toHaveLength(1);
    expect(args).toContain('/etc/custom.json');
  });

  it('structured_output이 있으면 content로 사용', async () => {
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({
      result: '{"answer":"blue"}',
      structured_output: { answer: 'blue' },
      usage: { input_tokens: 1, output_tokens: 2 },
    })));
    const provider = new ClaudeProvider(config('claude'));
    const result = await provider.execute(options({ chatResponseFormat: jsonSchemaFormat }));
    expect(JSON.parse(result.content)).toEqual({ answer: 'blue' });
  });

  it('구조화 출력이 없으면 throw (result 텍스트 폴백 금지)', async () => {
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({
      result: 'plain prose',
      usage: { input_tokens: 1, output_tokens: 2 },
    })));
    const provider = new ClaudeProvider(config('claude'));
    await expect(provider.execute(options({ chatResponseFormat: jsonSchemaFormat })))
      .rejects.toThrow(/structured_output/);
  });

  it('response_format이 없으면 기존 result 경로 유지', async () => {
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({
      result: 'plain answer',
      structured_output: { answer: 'ignored' },
      usage: { input_tokens: 1, output_tokens: 2 },
    })));
    const provider = new ClaudeProvider(config('claude'));
    const result = await provider.execute(options());
    expect(result.content).toBe('plain answer');
  });

  it('스트리밍은 delta를 억제하고 구조화 값 1회만 emit', async () => {
    // 실측(claude 2.1.228): 스키마를 줘도 delta는 프로즈("blue")를 흘리고
    // 내부 StructuredOutput tool round-trip 뒤 최종 result에만 스키마 준수 값이 담긴다.
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({
      result: '{"answer":"blue"}',
      structured_output: { answer: 'blue' },
      usage: { input_tokens: 1, output_tokens: 2 },
    })));
    const provider = new ClaudeProvider(config('claude'));
    const events: ProviderEvent[] = [];
    for await (const ev of provider.executeStream(options({ stream: true, chatResponseFormat: jsonSchemaFormat }))) {
      events.push(ev);
    }
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'usage', 'done']);
    expect((events[0] as { type: 'text_delta'; text: string }).text).toBe('{"answer":"blue"}');
  });

  it('CLI 모드에서만 json_schema 지원 선언 (sdk/channel-worker는 미지원)', () => {
    expect(new ClaudeProvider(config('claude')).supportsResponseFormat(jsonSchemaFormat)).toBe(true);
    expect(new ClaudeProvider(config('claude')).supportsResponseFormat({ type: 'json_object' })).toBe(false);
    expect(new ClaudeProvider(config('claude', { mode: 'sdk' })).supportsResponseFormat(jsonSchemaFormat)).toBe(false);
    expect(new ClaudeProvider(config('claude', { mode: 'channel-worker' })).supportsResponseFormat(jsonSchemaFormat)).toBe(false);
  });
});

describe('CodexProvider - structured output', () => {
  const codexOptions = (extra: Partial<ExecuteOptions> = {}) => options({ model: 'gpt-5.5', ...extra });

  it('스키마를 파일로 쓰고 --output-schema로 경로 전달', async () => {
    mockSpawn(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"answer":"blue"}' },
    }));
    const provider = new CodexProvider(config('codex'));
    await provider.execute(codexOptions({ chatResponseFormat: jsonSchemaFormat }));

    const args = spawnMock.mock.calls[0][1] as string[];
    const idx = args.indexOf('--output-schema');
    expect(idx).toBeGreaterThanOrEqual(0);
    // codex는 인라인 JSON이 아니라 파일 경로를 받는다.
    expect(args[idx + 1]).toMatch(/\.json$/);
  });

  it('json_object/text는 --output-schema를 추가하지 않음', async () => {
    mockSpawn(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'ok' },
    }));
    const provider = new CodexProvider(config('codex'));
    await provider.execute(codexOptions({ chatResponseFormat: { type: 'json_object' } }));
    expect(spawnMock.mock.calls[0][1] as string[]).not.toContain('--output-schema');
  });

  it('스키마 요청 시 resume 분기를 타지 않음 (codex resume은 --output-schema 미지원)', async () => {
    mockSpawn(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"answer":"blue"}' },
    }));
    const provider = new CodexProvider(config('codex', {
      cli_options: { enable_session_reuse: true },
    }));
    // 세션이 있더라도 스키마 요청이면 새 exec여야 한다.
    await provider.execute(codexOptions({ clientKey: 'client-1', chatResponseFormat: jsonSchemaFormat }));
    await provider.execute(codexOptions({ clientKey: 'client-1', chatResponseFormat: jsonSchemaFormat }));

    const secondArgs = spawnMock.mock.calls[1][1] as string[];
    expect(secondArgs).not.toContain('resume');
    expect(secondArgs).toContain('--output-schema');
  });

  it('json_schema만 강제 가능하다고 선언 (app-server 모드는 미지원)', () => {
    expect(new CodexProvider(config('codex')).supportsResponseFormat(jsonSchemaFormat)).toBe(true);
    expect(new CodexProvider(config('codex')).supportsResponseFormat({ type: 'json_object' })).toBe(false);
    expect(new CodexProvider(config('codex', { mode: 'app-server' })).supportsResponseFormat(jsonSchemaFormat)).toBe(false);
  });
});
