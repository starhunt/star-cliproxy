import { describe, it, expect, vi, afterEach } from 'vitest';
import type { HttpProviderConfig, ExecuteOptions, ProviderEvent } from '@star-cliproxy/shared';
import { HttpProvider } from './http-provider.js';

const baseConfig: HttpProviderConfig = {
  enabled: true,
  base_url: 'http://localhost:8080/v1',
  default_model: 'test-model',
  max_concurrent: 1,
  timeout_ms: 10_000,
  display_name: 'Test HTTP',
};

// fetch 모킹 헬퍼: 응답 JSON과 캡처된 요청 body를 반환
function mockFetch(responseBody: unknown) {
  const captured: { body?: any } = {};
  const fn = vi.fn(async (_url: string, init: any) => {
    captured.body = JSON.parse(init.body as string);
    return {
      ok: true,
      status: 200,
      headers: { entries: () => [] as [string, string][] },
      text: async () => JSON.stringify(responseBody),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return captured;
}

function makeOptions(partial: Partial<ExecuteOptions>): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    model: 'test-model',
    stream: false,
    ...partial,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpProvider.execute - function calling', () => {
  it('tools를 백엔드 요청 body로 전달', async () => {
    const captured = mockFetch({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const provider = new HttpProvider('test', { ...baseConfig });
    const tools = [{ type: 'function' as const, function: { name: 'click', description: 'click', parameters: { type: 'object' } } }];

    await provider.execute(makeOptions({ tools, toolChoice: 'auto' }));

    expect(captured.body.tools).toEqual(tools);
    expect(captured.body.tool_choice).toBe('auto');
  });

  it('tools 미지정 시 body에 tools 필드 없음', async () => {
    const captured = mockFetch({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    });
    const provider = new HttpProvider('test', { ...baseConfig });

    await provider.execute(makeOptions({}));

    expect(captured.body.tools).toBeUndefined();
    expect(captured.body.tool_choice).toBeUndefined();
  });

  it('멀티턴: assistant tool_calls / tool 메시지의 name·tool_call_id 보존', async () => {
    const captured = mockFetch({
      choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
    });
    const provider = new HttpProvider('test', { ...baseConfig });

    await provider.execute(makeOptions({
      messages: [
        { role: 'user', content: 'click it' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'click', arguments: '{}' } }],
        },
        { role: 'tool', content: 'clicked', name: 'click', tool_call_id: 'call_1' },
      ],
    }));

    const msgs = captured.body.messages;
    expect(msgs[1].tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'click', arguments: '{}' } },
    ]);
    expect(msgs[2].name).toBe('click');
    expect(msgs[2].tool_call_id).toBe('call_1');
  });

  it('백엔드 응답의 tool_calls를 ExecuteResult.toolCalls로 추출', async () => {
    mockFetch({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            index: 0,
            id: 'chatcmpl-tool-abc',
            type: 'function',
            function: { name: 'click_element', arguments: '{"selector":"#nav"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const provider = new HttpProvider('test', { ...baseConfig });

    const result = await provider.execute(makeOptions({}));

    expect(result.toolCalls).toEqual([{
      id: 'chatcmpl-tool-abc',
      type: 'function',
      function: { name: 'click_element', arguments: '{"selector":"#nav"}' },
      index: 0,
    }]);
    expect(result.finishReason).toBe('tool_calls');
  });

  it('tool_calls 없으면 toolCalls 미설정', async () => {
    mockFetch({
      choices: [{ message: { content: 'plain' }, finish_reason: 'stop' }],
    });
    const provider = new HttpProvider('test', { ...baseConfig });

    const result = await provider.execute(makeOptions({}));

    expect(result.toolCalls).toBeUndefined();
    expect(result.content).toBe('plain');
  });
});

describe('HttpProvider.executeStream - function calling', () => {
  // SSE 스트림을 ReadableStream으로 모킹
  function mockStream(lines: string[]) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { entries: () => [] as [string, string][], get: () => null },
      body: stream,
    } as unknown as Response)));
  }

  it('delta.tool_calls를 tool_use 이벤트로 변환 (index 보존)', async () => {
    mockStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"click","arguments":"{\\"x\\":1}"}}]}}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
      'data: [DONE]\n',
    ]);
    const provider = new HttpProvider('test', { ...baseConfig });

    const events: ProviderEvent[] = [];
    for await (const ev of provider.executeStream(makeOptions({ stream: true }))) {
      events.push(ev);
    }

    const toolEvent = events.find((e) => e.type === 'tool_use');
    expect(toolEvent).toMatchObject({
      type: 'tool_use',
      toolCallId: 'call_1',
      toolName: 'click',
      input: '{"x":1}',
      index: 0,
    });
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent).toMatchObject({ type: 'done', finishReason: 'tool_use' });
  });

  it("'done' 수신 후 reader.cancel()로 백엔드 스트림을 취소하고 잔여 바이트를 방출하지 않는다", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n'));
        // [DONE] 이후 추가 바이트: generator가 done에서 return하면 소비되면 안 됨.
        // close()를 호출하지 않으므로 명시적 cancel()이 없으면 스트림이 열린 채 유지된다.
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"leak"}}]}\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { entries: () => [] as [string, string][], get: () => null },
      body: stream,
    } as unknown as Response)));

    const provider = new HttpProvider('test', { ...baseConfig });
    const events: ProviderEvent[] = [];
    for await (const ev of provider.executeStream(makeOptions({ stream: true }))) {
      events.push(ev);
    }

    expect(cancelled).toBe(true);
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'leak')).toBe(false);
  });
});
