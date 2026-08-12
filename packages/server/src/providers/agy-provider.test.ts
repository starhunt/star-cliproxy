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

function agyJson(
  response: string,
  usage = {
    input_tokens: 10,
    output_tokens: 4,
    thinking_tokens: 2,
    cache_read_tokens: 3,
    total_tokens: 19,
  },
): string {
  return JSON.stringify({
    conversation_id: 'test-conversation',
    status: 'SUCCESS',
    response,
    usage,
  });
}

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

beforeEach(() => {
  spawnMock.mockReset();
});

describe('AgyProvider.buildArgs', () => {
  it('messages를 -p 인수 1개로 직렬화', () => {
    const provider = new AgyProvider(baseConfig());
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions({ messages: [{ role: 'user', content: 'ping' }] }),
    );
    expect(args[args.indexOf('-p') + 1]).toBe('ping');
    expect(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2))
      .toEqual(['--output-format', 'json']);
  });

  it('placeholder default_model("antigravity")은 --model을 추가하지 않음 (agy 자동 선택)', () => {
    const provider = new AgyProvider(baseConfig());
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions({ model: 'antigravity' }),
    );
    expect(args).not.toContain('--model');
  });

  it('base model과 reasoning effort를 --model/--effort로 -p 앞에 전달', () => {
    const provider = new AgyProvider(baseConfig());
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions({ model: 'gemini-3.6-flash', reasoningEffort: 'low' }),
    );
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe('gemini-3.6-flash');
    expect(args[args.indexOf('--effort') + 1]).toBe('low');
    // 모든 플래그는 -p 앞에 와야 함 (agy print-mode 파싱 규칙).
    expect(modelIdx).toBeLessThan(args.indexOf('-p'));
  });

  it('variant suffix 모델에 body reasoningEffort가 있으면 base model로 정규화', () => {
    const provider = new AgyProvider(baseConfig());
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions({ model: 'gemini-3.6-flash-medium', reasoningEffort: 'high' }),
    );
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.6-flash');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
  });

  it('effort가 모델 ID 일부인 비-Gemini 모델은 suffix를 보존', () => {
    const provider = new AgyProvider(baseConfig());
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions({ model: 'gpt-oss-120b-medium', reasoningEffort: 'high' }),
    );
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-oss-120b-medium');
  });

  it('xhigh/max effort는 agy가 지원하는 high로 정규화', () => {
    const provider = new AgyProvider(baseConfig());
    for (const effort of ['xhigh', 'max'] as const) {
      const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
        baseOptions({ model: 'gemini-3.6-flash', reasoningEffort: effort }),
      );
      expect(args[args.indexOf('--effort') + 1]).toBe('high');
    }
  });

  it('빈 model은 --model을 추가하지 않음', () => {
    const provider = new AgyProvider(baseConfig());
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions({ model: '   ' }),
    );
    expect(args).not.toContain('--model');
  });

  it('extra_args에 --model이 있으면 중복 추가하지 않고 사용자 값 존중', () => {
    const provider = new AgyProvider(baseConfig({
      extra_args: ['--model', 'gemini-3.1-pro-high'],
    }));
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions({ model: 'gemini-3.5-flash-low' }),
    );
    expect(args.filter((a) => a === '--model')).toHaveLength(1);
    expect(args).toContain('gemini-3.1-pro-high');
    expect(args).not.toContain('gemini-3.5-flash-low');
  });

  it('extra_args를 -p prompt 앞에 그대로 prepend', () => {
    const provider = new AgyProvider(baseConfig({
      extra_args: ['--dangerously-skip-permissions', '--sandbox'],
    }));
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions(),
    );
    expect(args).toEqual([
      '--dangerously-skip-permissions',
      '--sandbox',
      '--output-format',
      'json',
      '-p',
      'hello',
    ]);
  });

  it('extra_args의 output format은 provider가 요구하는 형식으로 교체', () => {
    const provider = new AgyProvider(baseConfig({
      extra_args: ['--output-format', 'text', '--print-timeout', '120'],
    }));
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions(),
    );
    expect(args.filter((arg) => arg === '--output-format')).toHaveLength(1);
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(args).not.toContain('text');
  });

  it('response_format=json_schema는 중첩 schema만 --json-schema로 -p 앞에 전달', () => {
    const provider = new AgyProvider(baseConfig());
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions({ chatResponseFormat: jsonSchemaFormat }),
    );
    const idx = args.indexOf('--json-schema');
    expect(idx).toBeGreaterThanOrEqual(0);
    // OpenAI 래퍼(name/strict)가 아니라 중첩 schema만 전달해야 agy가 그대로 강제한다.
    expect(JSON.parse(args[idx + 1])).toEqual(jsonSchemaFormat.json_schema.schema);
    expect(idx).toBeLessThan(args.indexOf('-p'));
  });

  it('response_format=json_object/text는 --json-schema를 추가하지 않음', () => {
    const provider = new AgyProvider(baseConfig());
    for (const format of [{ type: 'json_object' as const }, { type: 'text' as const }]) {
      const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
        baseOptions({ chatResponseFormat: format }),
      );
      expect(args).not.toContain('--json-schema');
    }
  });

  it('extra_args에 --json-schema가 있으면 중복 추가하지 않고 사용자 값 존중', () => {
    const provider = new AgyProvider(baseConfig({
      extra_args: ['--json-schema', '/etc/schemas/custom.json'],
    }));
    const args = (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
      baseOptions({ chatResponseFormat: jsonSchemaFormat }),
    );
    expect(args.filter((arg) => arg === '--json-schema')).toHaveLength(1);
    expect(args).toContain('/etc/schemas/custom.json');
  });

  it('prompt + schema 합계가 ARG_MAX 한도를 넘으면 throw', () => {
    const provider = new AgyProvider(baseConfig());
    const hugeSchema = {
      type: 'json_schema' as const,
      json_schema: {
        name: 'huge',
        schema: { type: 'object', description: 'x'.repeat(799_000) },
      },
    };
    expect(() =>
      (provider as unknown as { buildArgs(opts: ExecuteOptions): string[] }).buildArgs(
        baseOptions({ messages: [{ role: 'user', content: 'y'.repeat(2_000) }], chatResponseFormat: hugeSchema }),
      ),
    ).toThrow(/exceeds/);
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

describe('AgyProvider.execute (JSON 결과 파싱)', () => {
  it('JSON response를 trim해 content로 반환', async () => {
    spawnMock.mockReturnValue(fakeChild(agyJson('  Hello from agy.  \n')));
    const provider = new AgyProvider(baseConfig());
    const result = await provider.execute(baseOptions());
    expect(result.content).toBe('Hello from agy.');
    expect(result.finishReason).toBe('stop');
  });

  it('ANSI 색상 시퀀스를 스트립', async () => {
    spawnMock.mockReturnValue(fakeChild(agyJson('\x1B[31mred\x1B[0m text')));
    const provider = new AgyProvider(baseConfig());
    const result = await provider.execute(baseOptions());
    expect(result.content).toBe('red text');
  });

  it('non-zero exit code는 stderr 메시지와 함께 throw', async () => {
    spawnMock.mockReturnValue(fakeChild('', 'auth required', 1));
    const provider = new AgyProvider(baseConfig());
    await expect(provider.execute(baseOptions())).rejects.toThrow(/auth required/);
  });

  it('exit code가 0이어도 result status=ERROR이면 throw', async () => {
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({
      status: 'ERROR',
      response: '',
      error: 'invalid model',
    })));
    const provider = new AgyProvider(baseConfig());
    await expect(provider.execute(baseOptions())).rejects.toThrow(/invalid model/);
  });

  it('json_schema 요청은 오염된 response 대신 structured_output을 content로 반환', async () => {
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({
      status: 'SUCCESS',
      // 실측: response에는 프로즈와 스키마 외 필드가 섞여 유효한 JSON이 아니다.
      response: 'Blue\n{"answer":"Blue","toolAction":"Finish task"}\n',
      structured_output: { answer: 'Blue' },
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    })));
    const provider = new AgyProvider(baseConfig());
    const result = await provider.execute(baseOptions({ chatResponseFormat: jsonSchemaFormat }));
    expect(result.content).toBe('{"answer":"Blue"}');
    expect(JSON.parse(result.content)).toEqual({ answer: 'Blue' });
  });

  it('json_schema 요청인데 structured_output이 없으면 throw (오염된 response 폴백 금지)', async () => {
    spawnMock.mockReturnValue(fakeChild(agyJson('Blue\n{"answer":"Blue"}')));
    const provider = new AgyProvider(baseConfig());
    await expect(provider.execute(baseOptions({ chatResponseFormat: jsonSchemaFormat })))
      .rejects.toThrow(/structured_output/);
  });

  it('response_format이 없으면 structured_output이 있어도 기존 response 경로 유지', async () => {
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({
      status: 'SUCCESS',
      response: 'plain answer',
      structured_output: { answer: 'ignored' },
      usage: { total_tokens: 3 },
    })));
    const provider = new AgyProvider(baseConfig());
    const result = await provider.execute(baseOptions());
    expect(result.content).toBe('plain answer');
  });

  it('실제 input/output/thinking/cache token usage를 변환', async () => {
    spawnMock.mockReturnValue(fakeChild(agyJson('1234567890')));
    const provider = new AgyProvider(baseConfig());
    const result = await provider.execute(baseOptions());
    expect(result.usage).toEqual({
      promptTokens: 13,
      completionTokens: 6,
      totalTokens: 19,
    });
  });
});

describe('AgyProvider.executeStream (stream-json)', () => {
  it('text_delta → usage → done 순서로 이벤트 emit', async () => {
    spawnMock.mockReturnValue(fakeChild([
      JSON.stringify({ event: 'init', init: { model: 'gemini-3.6-flash-low' } }),
      JSON.stringify({
        event: 'step_update',
        step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'response ' },
      }),
      JSON.stringify({
        event: 'step_update',
        step_update: { step_type: 'agent_response', state: 'DONE', text_delta: 'body' },
      }),
      JSON.stringify({
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: 'response body',
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            thinking_tokens: 2,
            cache_read_tokens: 3,
            total_tokens: 19,
          },
        },
      }),
    ].join('\n')));
    const provider = new AgyProvider(baseConfig());
    const events: ProviderEvent[] = [];
    for await (const ev of provider.executeStream(baseOptions({ stream: true }))) {
      events.push(ev);
    }

    expect(events.map(e => e.type)).toEqual(['text_delta', 'text_delta', 'usage', 'done']);
    expect(events
      .filter((event): event is Extract<ProviderEvent, { type: 'text_delta' }> => event.type === 'text_delta')
      .map((event) => event.text)
      .join('')).toBe('response body');
    expect((events[3] as { type: 'done'; finishReason: string }).finishReason).toBe('stop');
  });

  it('result status=ERROR이면 stream을 throw', async () => {
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({
      event: 'result',
      result: { status: 'ERROR', error: 'quota exceeded' },
    })));
    const provider = new AgyProvider(baseConfig());
    const consume = async () => {
      for await (const _event of provider.executeStream(baseOptions({ stream: true }))) {
        // consume
      }
    };
    await expect(consume()).rejects.toThrow(/quota exceeded/);
  });

  it('json_schema 요청 시 프로즈 delta를 억제하고 최종 structured_output만 emit', async () => {
    // 실측(agy 1.1.12): 스키마를 줘도 agent_response delta는 프로즈("Blue")를 먼저 흘리고
    // 마지막 turn에서 스키마 외 필드가 섞인 JSON을 뱉는다. 둘을 이어붙이면 유효한 JSON이 아니다.
    spawnMock.mockReturnValue(fakeChild([
      JSON.stringify({
        event: 'step_update',
        step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Blue' },
      }),
      JSON.stringify({
        event: 'step_update',
        step_update: {
          step_type: 'agent_response',
          state: 'DONE',
          text_delta: '\n{"answer":"Blue","toolAction":"Finish task"}\n',
        },
      }),
      JSON.stringify({
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: 'Blue\n{"answer":"Blue","toolAction":"Finish task"}\n',
          structured_output: { answer: 'Blue' },
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      }),
    ].join('\n')));
    const provider = new AgyProvider(baseConfig());
    const events: ProviderEvent[] = [];
    for await (const event of provider.executeStream(baseOptions({ stream: true, chatResponseFormat: jsonSchemaFormat }))) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(['text_delta', 'usage', 'done']);
    expect((events[0] as { type: 'text_delta'; text: string }).text).toBe('{"answer":"Blue"}');
  });

  it('json_schema 요청인데 structured_output이 없으면 throw', async () => {
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({
      event: 'result',
      result: { status: 'SUCCESS', response: 'plain prose', usage: { total_tokens: 3 } },
    })));
    const provider = new AgyProvider(baseConfig());
    const consume = async () => {
      for await (const _event of provider.executeStream(baseOptions({ stream: true, chatResponseFormat: jsonSchemaFormat }))) {
        // consume
      }
    };
    await expect(consume()).rejects.toThrow(/structured_output/);
  });

  it('response_format이 없으면 기존 delta 스트리밍 동작 유지', async () => {
    spawnMock.mockReturnValue(fakeChild([
      JSON.stringify({
        event: 'step_update',
        step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'streamed' },
      }),
      JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: 'streamed', structured_output: { a: 1 }, usage: { total_tokens: 3 } },
      }),
    ].join('\n')));
    const provider = new AgyProvider(baseConfig());
    const events: ProviderEvent[] = [];
    for await (const event of provider.executeStream(baseOptions({ stream: true }))) {
      events.push(event);
    }
    expect((events[0] as { type: 'text_delta'; text: string }).text).toBe('streamed');
  });

  it('delta가 없는 호환 출력은 최종 response를 text_delta로 보존', async () => {
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({
      event: 'result',
      result: {
        status: 'SUCCESS',
        response: 'fallback response',
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      },
    })));
    const provider = new AgyProvider(baseConfig());
    const events: ProviderEvent[] = [];
    for await (const event of provider.executeStream(baseOptions({ stream: true }))) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(['text_delta', 'usage', 'done']);
    expect((events[0] as { type: 'text_delta'; text: string }).text).toBe('fallback response');
  });
});

describe('AgyProvider.supportsResponseFormat', () => {
  it('json_schema만 강제 가능하다고 선언 (agy --json-schema)', () => {
    const provider = new AgyProvider(baseConfig());
    expect(provider.supportsResponseFormat(jsonSchemaFormat)).toBe(true);
    expect(provider.supportsResponseFormat({ type: 'json_object' })).toBe(false);
    expect(provider.supportsResponseFormat({ type: 'text' })).toBe(false);
  });
});
