// clientKey 결정 헬퍼.
// 우선순위: X-Cliproxy-Session-Id 헤더(검증 통과) > apiKeyId > 'anonymous'
// 헤더 형식 검증: [A-Za-z0-9._:-], 1~128자 → 메모리 키 인젝션 방어.

import type { FastifyRequest } from 'fastify';

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SESSION_HEADER = 'x-cliproxy-session-id';

export function extractClientKey(request: FastifyRequest, apiKeyId: string | undefined): string {
  const raw = request.headers[SESSION_HEADER];
  const headerValue = Array.isArray(raw) ? raw[0] : raw;
  if (typeof headerValue === 'string' && SESSION_ID_RE.test(headerValue)) {
    return headerValue;
  }
  return apiKeyId || 'anonymous';
}
