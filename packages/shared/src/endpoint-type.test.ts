import { describe, it, expect } from 'vitest';
import { inferEndpointTypeFromName, effectiveEndpointType } from './endpoint-type.js';

describe('inferEndpointTypeFromName', () => {
  it('리랭커 이름을 rerank로 판정 (bge-reranker가 embeddings로 오탐되지 않음)', () => {
    expect(inferEndpointTypeFromName('bge-reranker')).toBe('rerank');
    expect(inferEndpointTypeFromName('BAAI/bge-reranker-v2-m3')).toBe('rerank');
    expect(inferEndpointTypeFromName('korean-reranker')).toBe('rerank');
  });

  it('임베딩 이름을 embeddings로 판정', () => {
    expect(inferEndpointTypeFromName('kure-v1')).toBe('embeddings');
    expect(inferEndpointTypeFromName('nlpai-lab/KURE-v1')).toBe('embeddings');
    expect(inferEndpointTypeFromName('text-embedding-3-large')).toBe('embeddings');
    expect(inferEndpointTypeFromName('korean-embedding')).toBe('embeddings');
  });

  it('TTS/이미지 이름 판정', () => {
    expect(inferEndpointTypeFromName('kokoro-tts')).toBe('tts');
    expect(inferEndpointTypeFromName('flux-schnell')).toBe('images');
    expect(inferEndpointTypeFromName('gemini-3-pro-image')).toBe('images');
  });

  it('일반 채팅 모델은 null (→ chat 폴백)', () => {
    expect(inferEndpointTypeFromName('gemma-4-12b')).toBeNull();
    expect(inferEndpointTypeFromName('claude-sonnet-4-6')).toBeNull();
    expect(inferEndpointTypeFromName('qwen3.6-27b-awq')).toBeNull();
    expect(inferEndpointTypeFromName('')).toBeNull();
  });
});

describe('effectiveEndpointType', () => {
  it('명시적 타입이 휴리스틱보다 우선', () => {
    // 이름은 embeddings로 보이지만 명시값 chat이 우선
    expect(effectiveEndpointType('chat', 'kure-v1')).toBe('chat');
  });

  it('명시값 없으면 이름 휴리스틱', () => {
    expect(effectiveEndpointType(undefined, 'kure-embed', 'kure-v1', 'nlpai-lab/KURE-v1')).toBe('embeddings');
  });

  it('명시값도 휴리스틱도 없으면 chat', () => {
    expect(effectiveEndpointType(undefined, 'gemma-4-12b')).toBe('chat');
    expect(effectiveEndpointType(null)).toBe('chat');
  });
});
