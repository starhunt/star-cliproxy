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

describe('HttpProvider.executeRerank - 업스트림 규격 협상', () => {
  const rerankConfig: HttpProviderConfig = {
    ...baseConfig,
    endpoint_type: 'rerank',
    default_model: 'bge-reranker',
  };

  /** 요청 body에 따라 응답을 달리하는 fetch 모킹. 보낸 body들을 순서대로 기록한다. */
  function mockRerankUpstream(
    respond: (body: any) => { status: number; payload: unknown },
  ) {
    const sent: any[] = [];
    const fn = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body as string);
      sent.push(body);
      const { status, payload } = respond(body);
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { entries: () => [] as [string, string][] },
        text: async () => JSON.stringify(payload),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fn);
    return sent;
  }

  /** TEI 규격만 받는 업스트림 (`texts` 없으면 400) */
  const teiUpstream = (body: any) =>
    Array.isArray(body.texts)
      ? { status: 200, payload: [{ index: 1, score: 0.9 }, { index: 0, score: 0.1 }] }
      : { status: 400, payload: { error: { message: 'texts is required' } } };

  /** OpenAI 호환 규격만 받는 업스트림 (cliproxy 체인 — model/documents 없으면 400) */
  const openaiUpstream = (body: any) =>
    body.model && Array.isArray(body.documents)
      ? {
          status: 200,
          payload: {
            results: [
              { index: 1, relevance_score: 0.8 },
              { index: 0, relevance_score: 0.2 },
            ],
            usage: { total_tokens: 13 },
          },
        }
      : {
          status: 400,
          payload: { error: { message: 'model, query, and documents (array) are required.' } },
        };

  const rerankOptions = { model: 'bge-reranker', query: 'q', documents: ['a', 'b'] };

  it('TEI 업스트림은 첫 시도(TEI 규격)로 성공 — 폴백 없음', async () => {
    const sent = mockRerankUpstream(teiUpstream);
    const provider = new HttpProvider('test', { ...rerankConfig });

    const r = await provider.executeRerank(rerankOptions);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ query: 'q', texts: ['a', 'b'] });
    expect(r.results.map((x) => x.index)).toEqual([1, 0]);
    expect(r.results[0].relevanceScore).toBeCloseTo(0.9);
  });

  it('OpenAI 호환 업스트림은 400 후 OpenAI 규격으로 폴백해 성공', async () => {
    const sent = mockRerankUpstream(openaiUpstream);
    const provider = new HttpProvider('test', { ...rerankConfig });

    const r = await provider.executeRerank(rerankOptions);

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ query: 'q', texts: ['a', 'b'] }); // 1차: TEI
    expect(sent[1]).toEqual({ model: 'bge-reranker', query: 'q', documents: ['a', 'b'] });
    expect(r.results.map((x) => x.index)).toEqual([1, 0]);
    expect(r.usage.totalTokens).toBe(13); // 업스트림 usage를 그대로 사용
  });

  it('통한 규격을 기억해 두 번째 호출부터는 왕복 1회', async () => {
    const sent = mockRerankUpstream(openaiUpstream);
    const provider = new HttpProvider('test', { ...rerankConfig });

    await provider.executeRerank(rerankOptions);
    expect(sent).toHaveLength(2);

    await provider.executeRerank(rerankOptions);
    expect(sent).toHaveLength(3); // 2회가 아니라 1회만 추가
    expect(sent[2].model).toBe('bge-reranker');
  });

  it('401(인증 실패)은 규격 문제가 아니므로 폴백하지 않음', async () => {
    const sent = mockRerankUpstream(() => ({
      status: 401,
      payload: { error: { message: 'invalid api key' } },
    }));
    const provider = new HttpProvider('test', { ...rerankConfig });

    await expect(provider.executeRerank(rerankOptions)).rejects.toThrow(/invalid api key/);
    expect(sent).toHaveLength(1);
  });

  it('두 규격 모두 실패하면 마지막 에러를 전파', async () => {
    const sent = mockRerankUpstream(() => ({
      status: 400,
      payload: { error: { message: 'nope' } },
    }));
    const provider = new HttpProvider('test', { ...rerankConfig });

    await expect(provider.executeRerank(rerankOptions)).rejects.toThrow(/nope/);
    expect(sent).toHaveLength(2);
  });

  it('topN·returnDocuments가 각 규격의 필드명으로 매핑됨', async () => {
    const sent = mockRerankUpstream(openaiUpstream);
    const provider = new HttpProvider('test', { ...rerankConfig });

    await provider.executeRerank({ ...rerankOptions, topN: 1, returnDocuments: true });

    expect(sent[0]).toMatchObject({ return_text: true }); // TEI
    expect(sent[1]).toMatchObject({ return_documents: true, top_n: 1 }); // OpenAI
  });

  it('Cohere식 document 객체({text})도 문자열로 정규화', async () => {
    mockRerankUpstream((body) =>
      body.model
        ? {
            status: 200,
            payload: { results: [{ index: 0, relevance_score: 0.5, document: { text: 'doc-a' } }] },
          }
        : { status: 400, payload: { error: { message: 'need openai format' } } },
    );
    const provider = new HttpProvider('test', { ...rerankConfig });

    const r = await provider.executeRerank({ ...rerankOptions, returnDocuments: true });

    expect(r.results[0].document).toBe('doc-a');
  });
});

describe('HttpProvider - structured output (response_format)', () => {
  const jsonSchemaFormat = {
    type: 'json_schema' as const,
    json_schema: {
      name: 'answer_shape',
      strict: true,
      schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    },
  };

  it('chatResponseFormat을 OpenAI 호환 body의 response_format으로 패스스루', async () => {
    const captured = mockFetch({
      choices: [{ message: { content: '{"answer":"Blue"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const provider = new HttpProvider('test', { ...baseConfig });

    await provider.execute(makeOptions({ chatResponseFormat: jsonSchemaFormat }));

    expect(captured.body.response_format).toEqual(jsonSchemaFormat);
  });

  it('스트리밍 요청에도 response_format을 전달', async () => {
    const captured = mockFetch({ choices: [{ message: { content: 'x' } }] });
    const provider = new HttpProvider('test', { ...baseConfig });

    // 스트리밍 body 빌드만 검증하면 되므로 첫 청크 수신 후 즉시 중단한다.
    const iterator = provider.executeStream(makeOptions({ stream: true, chatResponseFormat: { type: 'json_object' } }));
    try {
      for await (const _event of iterator) break;
    } catch {
      // mock 응답은 SSE가 아니므로 파싱 실패는 무시 — 검증 대상은 요청 body다.
    }

    expect(captured.body.response_format).toEqual({ type: 'json_object' });
  });

  it('response_format 미지정 시 body에 필드 없음', async () => {
    const captured = mockFetch({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    const provider = new HttpProvider('test', { ...baseConfig });

    await provider.execute(makeOptions({}));

    expect(captured.body.response_format).toBeUndefined();
  });

  it('모든 response_format 타입을 강제 가능하다고 선언 (백엔드 패스스루)', () => {
    const provider = new HttpProvider('test', { ...baseConfig });
    expect(provider.supportsResponseFormat(jsonSchemaFormat)).toBe(true);
    expect(provider.supportsResponseFormat({ type: 'json_object' })).toBe(true);
    expect(provider.supportsResponseFormat({ type: 'text' })).toBe(true);
  });
});
