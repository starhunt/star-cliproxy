import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecuteOptions, ProviderConfigYaml, ProviderEvent } from '@star-cliproxy/shared';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
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
import { GrokProvider } from './grok-provider.js';

const spawnMock = vi.mocked(spawn);

function baseConfig(extra: Partial<ProviderConfigYaml> = {}): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: 'grok',
    default_model: 'grok-4.5',
    max_concurrent: 1,
    timeout_ms: 30_000,
    extra_args: [],
    ...extra,
  };
}

function baseOptions(extra: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    model: 'grok-4.5',
    stream: false,
    ...extra,
  };
}

function grokJson(
  text: string,
  usage = {
    input_tokens: 10,
    cache_read_input_tokens: 3,
    output_tokens: 4,
    total_tokens: 17,
  },
): string {
  return JSON.stringify({
    text,
    stopReason: 'EndTurn',
    sessionId: 'session-1',
    requestId: 'request-1',
    usage,
  });
}

// child_process.spawn 모킹 — 실제 grok 바이너리 호출 없이 stdout/stderr/exitCode 시뮬레이션.
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

describe('GrokProvider.buildArgs', () => {
  it('프롬프트를 -p, 모델을 -m 인수로 전달', () => {
    const provider = new GrokProvider(baseConfig());
    const args = (provider as unknown as BuildArgs).buildArgs(
      baseOptions({ messages: [{ role: 'user', content: 'ping' }], model: 'grok-4.5' }),
    );
    expect(args[args.indexOf('-m') + 1]).toBe('grok-4.5');
    expect(args[args.indexOf('-p') + 1]).toBe('ping');
    expect(args).toContain('--no-auto-update');
    expect(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2))
      .toEqual(['--output-format', 'json']);
  });

  it('options.model이 없으면 default_model을 -m으로 사용', () => {
    const provider = new GrokProvider(baseConfig({ default_model: 'grok-4.5' }));
    const args = (provider as unknown as BuildArgs).buildArgs(
      baseOptions({ model: '' }),
    );
    expect(args[args.indexOf('-m') + 1]).toBe('grok-4.5');
  });

  it('extra_args를 -m/-p 앞에 prepend하고 prompt를 마지막에 둠', () => {
    const provider = new GrokProvider(baseConfig({ extra_args: ['--effort', 'high'] }));
    const args = (provider as unknown as BuildArgs).buildArgs(baseOptions());
    expect(args.slice(0, 2)).toEqual(['--effort', 'high']);
    expect(args[args.length - 2]).toBe('-p');
    expect(args[args.length - 1]).toBe('hello');
  });

  it('extra_args의 output format은 provider가 요구하는 형식으로 교체', () => {
    const provider = new GrokProvider(baseConfig({
      extra_args: ['--output-format=plain', '--always-approve'],
    }));
    const args = (provider as unknown as BuildArgs).buildArgs(baseOptions());
    expect(args.filter((arg) => arg === '--output-format')).toHaveLength(1);
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(args).not.toContain('--output-format=plain');
  });

  it('default_model이 빈 문자열이면 -m을 생략', () => {
    const provider = new GrokProvider(baseConfig({ default_model: '' }));
    const args = (provider as unknown as BuildArgs).buildArgs(baseOptions({ model: '' }));
    expect(args).not.toContain('-m');
    expect(args[args.indexOf('-p') + 1]).toBe('hello');
  });

  it('800KB 초과 prompt는 빌드 단계에서 즉시 throw (ARG_MAX 보호)', () => {
    const provider = new GrokProvider(baseConfig());
    const huge = 'x'.repeat(800_001);
    expect(() =>
      (provider as unknown as BuildArgs).buildArgs(
        baseOptions({ messages: [{ role: 'user', content: huge }] }),
      ),
    ).toThrow(/prompt exceeds/);
  });

  it('지원 effort는 그대로 전달하고 xhigh/max는 high로 정규화', () => {
    const provider = new GrokProvider(baseConfig());
    for (const [effort, expected] of [
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
      ['xhigh', 'high'],
      ['max', 'high'],
    ] as const) {
      const args = (provider as unknown as BuildArgs).buildArgs(
        baseOptions({ reasoningEffort: effort }),
      );
      expect(args[args.indexOf('--effort') + 1]).toBe(expected);
    }
  });

  it('reasoningEffort 미지정 시 --effort 플래그 없음', () => {
    const provider = new GrokProvider(baseConfig());
    const args = (provider as unknown as BuildArgs).buildArgs(baseOptions());
    expect(args).not.toContain('--effort');
  });

  it('extra_args에 --effort가 있으면 reasoningEffort를 중복 추가하지 않음', () => {
    const provider = new GrokProvider(baseConfig({ extra_args: ['--effort', 'low'] }));
    const args = (provider as unknown as BuildArgs).buildArgs(
      baseOptions({ reasoningEffort: 'high' }),
    );
    expect(args.filter((a) => a === '--effort')).toHaveLength(1);
    expect(args).not.toContain('high');
  });

  it('extra_args에 --reasoning-effort가 있어도 중복 --effort를 추가하지 않음', () => {
    const provider = new GrokProvider(baseConfig({ extra_args: ['--reasoning-effort', 'low'] }));
    const args = (provider as unknown as BuildArgs).buildArgs(
      baseOptions({ reasoningEffort: 'high' }),
    );
    expect(args).not.toContain('--effort');
  });

  it('--effort는 -p prompt 앞에 위치 (print-mode 파싱)', () => {
    const provider = new GrokProvider(baseConfig());
    const args = (provider as unknown as BuildArgs).buildArgs(
      baseOptions({ reasoningEffort: 'high' }),
    );
    expect(args.indexOf('--effort')).toBeLessThan(args.indexOf('-p'));
  });
});

describe('GrokProvider.execute (JSON 결과 파싱)', () => {
  it('JSON text를 trim해 content로 반환', async () => {
    spawnMock.mockReturnValue(fakeChild(grokJson('  Hello from grok.  \n')));
    const provider = new GrokProvider(baseConfig());
    const result = await provider.execute(baseOptions());
    expect(result.content).toBe('Hello from grok.');
    expect(result.finishReason).toBe('stop');
  });

  it('ANSI 색상 시퀀스를 스트립', async () => {
    spawnMock.mockReturnValue(fakeChild(grokJson('\x1B[32mGreen\x1B[0m text')));
    const provider = new GrokProvider(baseConfig());
    const result = await provider.execute(baseOptions());
    expect(result.content).toBe('Green text');
  });

  it('non-zero exit code는 stderr 메시지와 함께 throw', async () => {
    spawnMock.mockReturnValue(fakeChild('', 'auth required', 1));
    const provider = new GrokProvider(baseConfig());
    await expect(provider.execute(baseOptions())).rejects.toThrow(/auth required/);
  });

  it('CLI의 실제 usage를 OpenAI usage로 변환', async () => {
    spawnMock.mockReturnValue(fakeChild(grokJson('1234567890')));
    const provider = new GrokProvider(baseConfig());
    const result = await provider.execute(baseOptions());
    expect(result.usage).toEqual({
      promptTokens: 13,
      completionTokens: 4,
      totalTokens: 17,
    });
  });

  it('800KB 초과 prompt는 임시 --prompt-file로 전달하고 실행 후 제거', async () => {
    const huge = 'x'.repeat(800_001);
    let promptPath = '';
    spawnMock.mockImplementation((_command, args) => {
      const cliArgs = args as string[];
      promptPath = cliArgs[cliArgs.indexOf('--prompt-file') + 1];
      expect(readFileSync(promptPath, 'utf8')).toBe(huge);
      expect(cliArgs).not.toContain('-p');
      return fakeChild(grokJson('ok'));
    });

    const provider = new GrokProvider(baseConfig());
    const result = await provider.execute(baseOptions({
      messages: [{ role: 'user', content: huge }],
    }));

    expect(result.content).toBe('ok');
    expect(promptPath).not.toBe('');
    expect(existsSync(promptPath)).toBe(false);
  });
});

describe('GrokProvider.executeStream (streaming-json)', () => {
  it('text/thought/end를 실제 스트리밍 이벤트로 변환', async () => {
    spawnMock.mockReturnValue(fakeChild([
      JSON.stringify({ type: 'text', data: 'response ' }),
      JSON.stringify({ type: 'thought', data: 'reasoning' }),
      JSON.stringify({ type: 'text', data: 'body' }),
      JSON.stringify({
        type: 'end',
        stopReason: 'EndTurn',
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 3,
          output_tokens: 4,
          total_tokens: 17,
        },
      }),
    ].join('\n')));
    const provider = new GrokProvider(baseConfig());
    const events: ProviderEvent[] = [];
    for await (const ev of provider.executeStream(baseOptions({ stream: true }))) {
      events.push(ev);
    }
    expect(events.map(e => e.type)).toEqual([
      'text_delta',
      'thinking',
      'text_delta',
      'usage',
      'done',
    ]);
    expect((events[0] as { type: 'text_delta'; text: string }).text).toBe('response ');
    expect((events[1] as { type: 'thinking'; text: string }).text).toBe('reasoning');
    expect((events[2] as { type: 'text_delta'; text: string }).text).toBe('body');
    expect((events[3] as { type: 'usage'; usage: unknown }).usage).toEqual({
      promptTokens: 13,
      completionTokens: 4,
      totalTokens: 17,
    });
    expect((events[4] as { type: 'done'; finishReason: string }).finishReason).toBe('stop');
  });

  it('end 이벤트가 없으면 오류', async () => {
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({ type: 'text', data: 'partial' })));
    const provider = new GrokProvider(baseConfig());
    const collect = async () => {
      for await (const _ev of provider.executeStream(baseOptions({ stream: true }))) {
        // consume
      }
    };
    await expect(collect()).rejects.toThrow(/without an end event/);
  });

  it('error 이벤트를 오류로 전달', async () => {
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({ type: 'error', message: 'bad model' })));
    const provider = new GrokProvider(baseConfig());
    const collect = async () => {
      for await (const _ev of provider.executeStream(baseOptions({ stream: true }))) {
        // consume
      }
    };
    await expect(collect()).rejects.toThrow(/bad model/);
  });
});

describe('GrokProvider - structured output (response_format)', () => {
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

  it('중첩 schema만 --json-schema로 전달', () => {
    const provider = new GrokProvider(baseConfig());
    const args = (provider as unknown as BuildArgs).buildArgs(
      baseOptions({ chatResponseFormat: jsonSchemaFormat }),
    );
    const idx = args.indexOf('--json-schema');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(args[idx + 1])).toEqual(jsonSchemaFormat.json_schema.schema);
  });

  it('json_object/text는 --json-schema를 추가하지 않음', () => {
    const provider = new GrokProvider(baseConfig());
    for (const format of [{ type: 'json_object' as const }, { type: 'text' as const }]) {
      const args = (provider as unknown as BuildArgs).buildArgs(baseOptions({ chatResponseFormat: format }));
      expect(args).not.toContain('--json-schema');
    }
  });

  it('extra_args에 --json-schema가 있으면 사용자 값 존중', () => {
    const provider = new GrokProvider(baseConfig({ extra_args: ['--json-schema', '/etc/custom.json'] }));
    const args = (provider as unknown as BuildArgs).buildArgs(
      baseOptions({ chatResponseFormat: jsonSchemaFormat }),
    );
    expect(args.filter((arg) => arg === '--json-schema')).toHaveLength(1);
    expect(args).toContain('/etc/custom.json');
  });

  it('execute는 structuredOutput을 content로 반환', async () => {
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({
      text: '{"answer": "blue"}',
      stopReason: 'EndTurn',
      structuredOutput: { answer: 'blue' },
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    })));
    const provider = new GrokProvider(baseConfig());
    const result = await provider.execute(baseOptions({ chatResponseFormat: jsonSchemaFormat }));
    expect(JSON.parse(result.content)).toEqual({ answer: 'blue' });
  });

  it('execute는 snake_case structured_output도 인식', async () => {
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({
      text: 'x',
      stopReason: 'EndTurn',
      structured_output: { answer: 'blue' },
      usage: { total_tokens: 3 },
    })));
    const provider = new GrokProvider(baseConfig());
    const result = await provider.execute(baseOptions({ chatResponseFormat: jsonSchemaFormat }));
    expect(JSON.parse(result.content)).toEqual({ answer: 'blue' });
  });

  it('구조화 출력이 없으면 throw (텍스트 폴백 금지)', async () => {
    spawnMock.mockReturnValue(fakeChild(grokJson('plain prose')));
    const provider = new GrokProvider(baseConfig());
    await expect(provider.execute(baseOptions({ chatResponseFormat: jsonSchemaFormat })))
      .rejects.toThrow(/structuredOutput/);
  });

  it('response_format이 없으면 structuredOutput이 있어도 기존 text 경로 유지', async () => {
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({
      text: 'plain answer',
      stopReason: 'EndTurn',
      structuredOutput: { answer: 'ignored' },
      usage: { total_tokens: 3 },
    })));
    const provider = new GrokProvider(baseConfig());
    const result = await provider.execute(baseOptions());
    expect(result.content).toBe('plain answer');
  });

  it('스트리밍은 delta를 억제하고 구조화 값 1회만 emit', async () => {
    // 실측(grok 1.0.3): delta가 JSON 조각으로 오지만 CLI마다 동작이 갈리므로 통일해 버퍼링한다.
    spawnMock.mockReturnValue(fakeChild(JSON.stringify({
      text: '{"answer": "blue"}',
      stopReason: 'EndTurn',
      structuredOutput: { answer: 'blue' },
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    })));
    const provider = new GrokProvider(baseConfig());
    const events: ProviderEvent[] = [];
    for await (const ev of provider.executeStream(baseOptions({ stream: true, chatResponseFormat: jsonSchemaFormat }))) {
      events.push(ev);
    }
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'usage', 'done']);
    expect((events[0] as { type: 'text_delta'; text: string }).text).toBe('{"answer":"blue"}');
  });

  it('json_schema만 강제 가능하다고 선언', () => {
    const provider = new GrokProvider(baseConfig());
    expect(provider.supportsResponseFormat(jsonSchemaFormat)).toBe(true);
    expect(provider.supportsResponseFormat({ type: 'json_object' })).toBe(false);
  });
});
