import { describe, it, expect } from 'vitest';
import { isInvalidToolSchemaError, isToolsUnsupportedError } from './chat-completions.js';

describe('isToolsUnsupportedError', () => {
  it('vLLM 파서 미설정 에러를 감지', () => {
    const msg = 'a100gemma12 HTTP error: {"message":"\\"auto\\" tool choice requires '
      + '--enable-auto-tool-choice and --tool-call-parser to be set","type":"BadRequestError","code":400}';
    expect(isToolsUnsupportedError(msg)).toBe(true);
  });

  it('"does not support tools" 문구 감지', () => {
    expect(isToolsUnsupportedError('This model does not support tools.')).toBe(true);
  });

  it('function calling 미지원 감지', () => {
    expect(isToolsUnsupportedError('function calling is not supported by this model')).toBe(true);
  });

  it('tool-call-parser 누락 감지', () => {
    expect(isToolsUnsupportedError('no tool-call-parser configured')).toBe(true);
  });

  it('일반 타임아웃은 미감지', () => {
    expect(isToolsUnsupportedError('provider request timed out after 300000ms')).toBe(false);
  });

  it('모델 not found는 미감지', () => {
    expect(isToolsUnsupportedError('Model "x" not found. Check model mappings.')).toBe(false);
  });

  it('rate limit은 미감지', () => {
    expect(isToolsUnsupportedError('Rate limit exceeded. Retry after 30 seconds.')).toBe(false);
  });

  it('인증 실패는 미감지', () => {
    expect(isToolsUnsupportedError('HTTP error: Invalid API key')).toBe(false);
  });

  it('잘못된 tool JSON Schema는 tools 미지원으로 오분류하지 않음', () => {
    const message = 'tool "broken"의 parameters JSON Schema를 컴파일할 수 없습니다: schema is invalid';
    expect(isToolsUnsupportedError(message)).toBe(false);
    expect(isInvalidToolSchemaError(message)).toBe(true);
  });

  it('일반 tool argument 검증 실패는 client schema 오류로 분류하지 않음', () => {
    expect(isInvalidToolSchemaError(
      'tool call "get_weather" 인자가 스키마와 맞지 않습니다',
    )).toBe(false);
  });

  it('빈 문자열/undefined 안전', () => {
    expect(isToolsUnsupportedError('')).toBe(false);
    expect(isToolsUnsupportedError(undefined as unknown as string)).toBe(false);
  });
});
