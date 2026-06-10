import { describe, it, expect } from 'vitest';
import {
  ClaudeStreamParser,
  CodexStreamParser,
  GeminiStreamParser,
  PlainTextParser,
  formatAsSSE,
  createRequestId,
  getParserForProvider,
} from './stream-transformer.js';

describe('ClaudeStreamParser', () => {
  const parser = new ClaudeStreamParser();

  it('assistant 메시지에서 텍스트 추출', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello' }],
        role: 'assistant',
      },
    });
    const result = parser.parse(line);
    expect(result).toEqual({ type: 'delta', content: 'Hello' });
  });

  it('assistant 메시지에서 여러 텍스트 블록 결합', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world' },
        ],
      },
    });
    const result = parser.parse(line);
    expect(result).toEqual({ type: 'delta', content: 'Hello world' });
  });

  it('result를 done chunk로 변환 (토큰 사용량 포함)', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    const result = parser.parse(line);
    expect(result?.type).toBe('done');
    expect(result?.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it('빈 라인은 null 반환', () => {
    expect(parser.parse('')).toBeNull();
    expect(parser.parse('  ')).toBeNull();
  });

  it('system/init 이벤트는 null 반환', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init' });
    expect(parser.parse(line)).toBeNull();
  });

  it('rate_limit_event는 null 반환', () => {
    const line = JSON.stringify({ type: 'rate_limit_event' });
    expect(parser.parse(line)).toBeNull();
  });
});

describe('CodexStreamParser', () => {
  const parser = new CodexStreamParser();

  it('item.completed에서 텍스트 추출', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'Hello world' },
    });
    const result = parser.parse(line);
    expect(result).toEqual({ type: 'delta', content: 'Hello world' });
  });

  it('turn.completed를 done chunk로 변환 (토큰 사용량 포함)', () => {
    const line = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const result = parser.parse(line);
    expect(result?.type).toBe('done');
    expect(result?.usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
    });
  });

  it('turn.failed를 error로 변환', () => {
    const line = JSON.stringify({
      type: 'turn.failed',
      error: { message: 'Model not supported' },
    });
    const result = parser.parse(line);
    expect(result?.type).toBe('error');
  });

  it('thread.started는 null 반환', () => {
    const line = JSON.stringify({ type: 'thread.started', thread_id: 'abc' });
    expect(parser.parse(line)).toBeNull();
  });

  it('빈 라인은 null 반환', () => {
    expect(parser.parse('')).toBeNull();
  });

  it('plain text fallback', () => {
    const result = parser.parse('Hello world');
    expect(result).toEqual({ type: 'delta', content: 'Hello world' });
  });
});

describe('GeminiStreamParser', () => {
  const parser = new GeminiStreamParser();

  it('assistant delta 메시지에서 텍스트 추출', () => {
    const line = JSON.stringify({
      type: 'message',
      role: 'assistant',
      delta: true,
      content: 'Hello',
    });
    const result = parser.parse(line);
    expect(result).toEqual({ type: 'delta', content: 'Hello' });
  });

  it('user 메시지는 무시', () => {
    const line = JSON.stringify({
      type: 'message',
      role: 'user',
      content: 'What is 1+1?',
    });
    expect(parser.parse(line)).toBeNull();
  });

  it('result를 done chunk로 변환 (토큰 사용량 포함)', () => {
    const line = JSON.stringify({
      type: 'result',
      status: 'success',
      stats: { input_tokens: 50, output_tokens: 30, total_tokens: 80 },
    });
    const result = parser.parse(line);
    expect(result?.type).toBe('done');
    expect(result?.usage).toEqual({
      promptTokens: 50,
      completionTokens: 30,
      totalTokens: 80,
    });
  });

  it('init 이벤트는 무시', () => {
    const line = JSON.stringify({ type: 'init', session_id: 'abc' });
    expect(parser.parse(line)).toBeNull();
  });

  it('빈 라인은 null 반환', () => {
    expect(parser.parse('')).toBeNull();
  });
});

describe('formatAsSSE', () => {
  it('delta chunk를 SSE 형식으로 변환', () => {
    const result = formatAsSSE(
      { type: 'delta', content: 'Hi' },
      'chatcmpl-test-123',
      'gpt-4',
    );
    expect(result).toContain('data: ');
    expect(result).toContain('"content":"Hi"');
    expect(result).toContain('"model":"gpt-4"');
  });

  it('done chunk를 finish_reason stop + [DONE]으로 변환', () => {
    const result = formatAsSSE(
      { type: 'done' },
      'chatcmpl-test-123',
      'gpt-4',
    );
    expect(result).toContain('"finish_reason":"stop"');
    expect(result).toContain('data: [DONE]');
  });

  it('tool_use 이벤트를 delta.tool_calls SSE로 변환', () => {
    const result = formatAsSSE(
      { type: 'tool_use', toolCallId: 'call_1', toolName: 'click', input: '{"selector":"#x"}' },
      'chatcmpl-test-123',
      'gpt-4',
    );
    expect(result).toContain('"tool_calls"');
    expect(result).toContain('"id":"call_1"');
    expect(result).toContain('"name":"click"');
    expect(result).toContain('"type":"function"');
    expect(result).toContain('"index":0');
  });

  it('병렬 tool call은 event.index를 보존', () => {
    const result = formatAsSSE(
      { type: 'tool_use', toolCallId: 'call_2', toolName: 'scroll', input: '{}', index: 1 },
      'chatcmpl-test-123',
      'gpt-4',
    );
    expect(result).toContain('"index":1');
  });

  it('partial tool_use는 id/type/name 생략, arguments delta만 전송', () => {
    const result = formatAsSSE(
      { type: 'tool_use', toolCallId: '', toolName: '', input: '{"sel', isPartial: true, index: 0 },
      'chatcmpl-test-123',
      'gpt-4',
    );
    // SSE data 라인을 파싱하여 tool_call 객체 자체를 검사 (봉투의 id와 구분)
    const json = JSON.parse(result!.replace(/^data: /, '').trim());
    const tc = json.choices[0].delta.tool_calls[0];
    expect(tc.function.arguments).toBe('{"sel');
    expect(tc.id).toBeUndefined();
    expect(tc.type).toBeUndefined();
    expect(tc.function.name).toBeUndefined();
  });

  it('done(tool_use)는 finish_reason tool_calls로 변환', () => {
    const result = formatAsSSE(
      { type: 'done', finishReason: 'tool_use' },
      'chatcmpl-test-123',
      'gpt-4',
    );
    expect(result).toContain('"finish_reason":"tool_calls"');
    expect(result).toContain('data: [DONE]');
  });
});

describe('createRequestId', () => {
  it('chatcmpl-proxy- 접두사로 시작', () => {
    const id = createRequestId();
    expect(id).toMatch(/^chatcmpl-proxy-/);
  });
});

describe('getParserForProvider', () => {
  it('각 provider에 맞는 파서 반환', () => {
    expect(getParserForProvider('claude')).toBeInstanceOf(ClaudeStreamParser);
    expect(getParserForProvider('codex')).toBeInstanceOf(CodexStreamParser);
    expect(getParserForProvider('gemini')).toBeInstanceOf(GeminiStreamParser);
  });

  it('알 수 없는 provider는 PlainTextParser로 폴백', () => {
    const parser = getParserForProvider('unknown');
    expect(parser).toBeInstanceOf(PlainTextParser);
  });
});
