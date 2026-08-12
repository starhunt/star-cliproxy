import { describe, it, expect } from 'vitest';
import { validateResponseFormat } from './chat-completions.js';

describe('validateResponseFormat', () => {
  it('세 가지 OpenAI 타입을 모두 수용', () => {
    expect(validateResponseFormat({ type: 'text' })).toBeNull();
    expect(validateResponseFormat({ type: 'json_object' })).toBeNull();
    expect(validateResponseFormat({
      type: 'json_schema',
      json_schema: { name: 'shape', strict: true, schema: { type: 'object' } },
    })).toBeNull();
  });

  it('OpenAI가 요구하지 않는 필드(name/strict)가 없어도 통과', () => {
    expect(validateResponseFormat({
      type: 'json_schema',
      json_schema: { schema: { type: 'object' } },
    })).toBeNull();
  });

  it('객체가 아니면 거부', () => {
    expect(validateResponseFormat('json_object')).toMatch(/must be an object/);
    expect(validateResponseFormat(['json_object'])).toMatch(/must be an object/);
    expect(validateResponseFormat(null)).toMatch(/must be an object/);
  });

  it('알 수 없는 type은 거부', () => {
    expect(validateResponseFormat({ type: 'yaml' })).toMatch(/must be one of/);
    expect(validateResponseFormat({})).toMatch(/must be one of/);
  });

  it('json_schema인데 wrapper가 없거나 객체가 아니면 거부', () => {
    expect(validateResponseFormat({ type: 'json_schema' })).toMatch(/json_schema is required/);
    expect(validateResponseFormat({ type: 'json_schema', json_schema: 'x' })).toMatch(/json_schema is required/);
  });

  it('json_schema.schema가 JSON Schema 객체가 아니면 거부', () => {
    expect(validateResponseFormat({ type: 'json_schema', json_schema: { name: 'x' } }))
      .toMatch(/schema must be a JSON Schema object/);
    expect(validateResponseFormat({ type: 'json_schema', json_schema: { name: 'x', schema: [] } }))
      .toMatch(/schema must be a JSON Schema object/);
  });
});
