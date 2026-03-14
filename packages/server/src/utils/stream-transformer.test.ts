import { describe, it, expect } from 'vitest';
import {
  ClaudeStreamParser,
  CodexStreamParser,
  GeminiStreamParser,
  formatAsSSE,
  createRequestId,
  getParserForProvider,
} from './stream-transformer.js';

describe('ClaudeStreamParser', () => {
  const parser = new ClaudeStreamParser();

  it('text_delta를 delta chunk로 변환', () => {
    const line = JSON.stringify({ type: 'assistant', subtype: 'text_delta', text: 'Hello' });
    const result = parser.parse(line);
    expect(result).toEqual({ type: 'delta', content: 'Hello' });
  });

  it('result를 done chunk로 변환', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success' });
    const result = parser.parse(line);
    expect(result?.type).toBe('done');
  });

  it('빈 라인은 null 반환', () => {
    expect(parser.parse('')).toBeNull();
    expect(parser.parse('  ')).toBeNull();
  });

  it('알 수 없는 타입은 null 반환', () => {
    const line = JSON.stringify({ type: 'system', content: 'init' });
    expect(parser.parse(line)).toBeNull();
  });
});

describe('CodexStreamParser', () => {
  const parser = new CodexStreamParser();

  it('plain text를 delta로 변환', () => {
    const result = parser.parse('Hello world');
    expect(result).toEqual({ type: 'delta', content: 'Hello world' });
  });

  it('빈 라인은 null 반환', () => {
    expect(parser.parse('')).toBeNull();
  });
});

describe('GeminiStreamParser', () => {
  const parser = new GeminiStreamParser();

  it('text_delta를 delta chunk로 변환', () => {
    const line = JSON.stringify({ type: 'text_delta', content: 'Hello' });
    const result = parser.parse(line);
    expect(result).toEqual({ type: 'delta', content: 'Hello' });
  });

  it('turn_complete를 done으로 변환', () => {
    const line = JSON.stringify({ type: 'turn_complete' });
    const result = parser.parse(line);
    expect(result?.type).toBe('done');
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

  it('알 수 없는 provider는 에러', () => {
    expect(() => getParserForProvider('unknown')).toThrow();
  });
});
