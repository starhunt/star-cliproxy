import type { ChatResponseFormat } from '@star-cliproxy/shared';

/**
 * CLI 프로바이더의 structured output(OpenAI `response_format`) 공통 헬퍼.
 *
 * 각 CLI가 스키마를 받는 방법은 다르지만(agy/claude/grok은 `--json-schema` 인수,
 * codex는 `--output-schema <path>` 파일), 아래 규칙은 공통이다:
 *  - OpenAI 래퍼(name/strict)가 아니라 **중첩 schema만** CLI에 전달한다.
 *  - 응답은 CLI의 구조화 출력 필드를 정본으로 쓰고, 값이 없으면 텍스트로 폴백하지 않고 실패시킨다.
 *  - 스트리밍은 스키마 요청 시 중간 delta를 억제한다 (아래 주석 참고).
 */

/** 이 요청이 스키마 강제를 요구하는지. json_object/text는 CLI가 강제할 수단이 없어 제외한다. */
export function wantsSchemaEnforcement(
  format: ChatResponseFormat | undefined,
): format is Extract<ChatResponseFormat, { type: 'json_schema' }> {
  return format?.type === 'json_schema';
}

/** CLI에 넘길 JSON Schema 문자열. 스키마 강제 요청이 아니면 undefined. */
export function schemaArgument(format: ChatResponseFormat | undefined): string | undefined {
  return wantsSchemaEnforcement(format) ? JSON.stringify(format.json_schema.schema) : undefined;
}

/**
 * CLI의 구조화 출력 값을 OpenAI `message.content`로 쓸 JSON 문자열로 직렬화한다.
 *
 * 값이 없으면 CLI가 뱉은 일반 텍스트로 폴백하지 않고 던진다 — 클라이언트가 스키마를 만족하지
 * 않는 문자열을 구조화 응답으로 오인하는 것보다, 실패해서 다음 폴백 프로바이더로 넘어가는 편이 낫다.
 * (실측: agy의 `response`는 스키마를 줘도 프로즈와 스키마 외 필드가 섞인다.)
 */
export function requireStructuredOutput(value: unknown, cliLabel: string, fieldName: string): string {
  if (value === undefined || value === null) {
    throw new Error(
      `${cliLabel} CLI가 ${fieldName}을 반환하지 않았습니다 (response_format=json_schema). ` +
      `해당 CLI 버전이 스키마 강제를 지원하는지 확인하세요.`,
    );
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * 스키마 요청 시 스트리밍 delta를 억제해야 하는지.
 *
 * 항상 true다 — CLI별 실측 결과가 제각각이라 통일한다:
 *  - agy: delta가 프로즈("Blue")를 먼저 흘리고 마지막에 스키마 외 필드가 섞인 JSON을 뱉는다
 *  - claude: delta가 프로즈를 흘린 뒤 내부 StructuredOutput tool round-trip으로 최종 값을 만든다
 *  - grok: delta가 JSON 조각이라 이어붙이면 유효하지만, 다른 CLI와 동작이 갈린다
 *
 * 클라이언트가 프로바이더마다 다른 스트리밍 동작을 보지 않도록, 스키마 요청은 어느 CLI든
 * "완성된 구조화 값 1회 emit"으로 통일한다.
 */
export function shouldBufferStream(format: ChatResponseFormat | undefined): boolean {
  return wantsSchemaEnforcement(format);
}
