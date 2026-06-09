import type { EndpointType } from './types/provider.js';

// 이름(provider/alias/model/display_name 등)에서 엔드포인트 타입을 추론한다.
// endpoint_type 메타데이터가 없는 레거시 HTTP 프로바이더의 폴백 및
// 자동 감지 실패 시 힌트로 사용한다. 판정 불가 시 null 반환.
//
// 주의: 'whisper'(STT/전사)는 tts(text-to-speech) 엔드포인트와 다르므로 제외한다.
export function inferEndpointTypeFromName(...names: Array<string | null | undefined>): EndpointType | null {
  const s = names.filter(Boolean).join(' ').toLowerCase();
  if (!s) return null;

  // rerank를 embeddings보다 먼저 검사 (bge-reranker가 'bge'에 오탐되지 않도록)
  if (/(rerank|reranker|cross-?encoder)/.test(s)) return 'rerank';
  if (/(embed|embedding|kure|bge-m3|gte-|e5-|text-embedding|nomic-embed|jina-embed)/.test(s)) return 'embeddings';
  if (/(\btts\b|text-to-speech|speech|xtts|piper|kokoro|\bvoice\b)/.test(s)) return 'tts';
  if (/(\bimage\b|images|imagen|dall-?e|sdxl|stable-?diffusion|\bflux\b|nano-banana)/.test(s)) return 'images';

  return null;
}

// 명시적 endpoint_type이 있으면 그대로, 없으면 이름 휴리스틱, 그래도 불명이면 'chat'.
export function effectiveEndpointType(
  explicit: EndpointType | null | undefined,
  ...names: Array<string | null | undefined>
): EndpointType {
  if (explicit) return explicit;
  return inferEndpointTypeFromName(...names) ?? 'chat';
}
