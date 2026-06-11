import { describe, it, expect } from 'vitest';
import { redactSecrets } from './debug.js';

describe('redactSecrets', () => {
  it('프록시 키(sk-proxy-)를 마스킹', () => {
    expect(redactSecrets('key=sk-proxy-abc123XYZ')).toContain('sk-proxy-[redacted]');
    expect(redactSecrets('sk-proxy-abc123XYZ')).not.toContain('abc123XYZ');
  });

  it('Bearer 토큰을 마스킹', () => {
    expect(redactSecrets('Authorization: Bearer abc.def-ghi_123')).toContain('Bearer [redacted]');
  });

  it('x-admin-token / authorization 헤더(JSON)를 마스킹', () => {
    const json = '{"x-admin-token":"supersecret","authorization":"tok123"}';
    const out = redactSecrets(json);
    expect(out).toContain('"x-admin-token":"[redacted]"');
    expect(out).toContain('"authorization":"[redacted]"');
    expect(out).not.toContain('supersecret');
  });

  it('TOKEN/KEY/SECRET= 형식 환경변수를 마스킹', () => {
    expect(redactSecrets('OPENAI_API_KEY=sk-realvalue123')).toContain('OPENAI_API_KEY=[redacted]');
    expect(redactSecrets('MY_SECRET=hunter2')).toContain('MY_SECRET=[redacted]');
  });

  it('서드파티 키 형식(프롬프트 본문에 섞인 백엔드 키)을 마스킹', () => {
    // OpenAI/Anthropic sk- (20자 이상)
    expect(redactSecrets('내 키는 sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA 입니다'))
      .not.toContain('AAAAAAAAAAAAAAAAAAAAAAAA');
    // AWS access key id
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toContain('AKIA[redacted]');
    // Google API key (AIza + 35자)
    expect(redactSecrets('AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe')).toContain('AIza[redacted]');
    // GitHub token
    expect(redactSecrets('ghp_0123456789012345678901234567890123456789')).toContain('gh_[redacted]');
    // xAI key
    expect(redactSecrets('xai-0123456789abcdefghij')).toContain('xai-[redacted]');
  });

  it('시크릿이 아닌 평문은 그대로 유지', () => {
    const plain = '안녕하세요. 오늘 날씨는 어떤가요? skiing is fun.';
    expect(redactSecrets(plain)).toBe(plain);
  });
});
