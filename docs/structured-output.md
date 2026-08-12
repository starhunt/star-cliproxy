# Structured Output (`response_format`)

OpenAI Chat Completions의 `response_format`을 받아 프로바이더별 구조화 출력 기능에 연결합니다.
`message.content`에는 스키마를 만족하는 JSON 문자열이 담기므로, Ax(`.useStructured()`)나 OpenAI SDK의
structured output 클라이언트가 그대로 파싱할 수 있습니다.

## 지원 매트릭스

| 프로바이더 | `json_schema` | `json_object` / `text` | 방식 |
|-----------|---------------|------------------------|------|
| `agy` (Antigravity / Gemini) | ✅ | ❌ | `agy --json-schema`로 스키마 강제 후 `structured_output` 반환 |
| HTTP 프로바이더 (OpenAI 호환) | ✅ | ✅ | 요청 body의 `response_format`을 백엔드로 패스스루 |
| 그 외 CLI 프로바이더 | ❌ | ❌ | 무시 (아래 "미지원 프로바이더" 참고) |

`agy`는 1.1.12 기준 `--json-schema`를 지원합니다. 그보다 낮은 버전에서는 CLI가 스키마를 무시하고
`structured_output` 없이 응답하므로, 프록시가 요청을 실패시키고 다음 폴백 프로바이더로 넘깁니다.

## 사용 예

```bash
curl -X POST http://127.0.0.1:8300/v1/chat/completions \
  -H "Authorization: Bearer sk-proxy-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-flash",
    "messages": [{ "role": "user", "content": "Answer with one word: sky color." }],
    "response_format": {
      "type": "json_schema",
      "json_schema": {
        "name": "answer_shape",
        "strict": true,
        "schema": {
          "type": "object",
          "properties": { "answer": { "type": "string" } },
          "required": ["answer"],
          "additionalProperties": false
        }
      }
    }
  }'
```

```json
{
  "choices": [{ "message": { "role": "assistant", "content": "{\"answer\":\"Blue\"}" } }]
}
```

스트리밍(`"stream": true`)도 동일하게 동작합니다. 델타를 모두 이어붙이면 스키마를 만족하는 JSON 하나가 됩니다.

## 동작 규칙

- **전달되는 것은 중첩 `schema`뿐입니다.** OpenAI 래퍼의 `name`/`strict`는 CLI로 넘기지 않습니다.
- **agy 스트리밍은 중간 delta를 억제합니다.** agy는 스키마를 최종 결과에만 적용하고 중간 델타로는
  프로즈를 흘리므로(`Blue` → `{"answer":"Blue","toolAction":...}`), 그대로 이어붙이면 유효한 JSON이
  아닙니다. 프록시는 최종 `structured_output` 하나만 델타로 내보냅니다.
- **`json_schema` 요청은 reasoning 마커 분리를 건너뜁니다.** 스키마 값 안에 마커와 같은 문자열이
  있어도 잘려나가지 않습니다.
- **`json_schema` 요청은 응답 캐시를 사용하지 않습니다.** 캐시 키가 model+messages라
  스키마 없는 응답과 섞일 수 있기 때문입니다.
- **provider `extra_args`가 우선합니다.** `extra_args`에 `--json-schema`를 직접 넣어 두면
  요청의 `response_format`보다 그 값이 우선합니다(`--model`/`--effort`와 동일한 정책).

## 미지원 프로바이더

강제할 수단이 없는 프로바이더로 라우팅되면 **요청은 그대로 진행하되** 응답에 헤더로 알립니다.

```
X-Unsupported-Params: response_format
```

기존 `temperature`/`max_tokens` 처리와 같은 방식입니다. 폴백 체인 중 일부만 미지원인 경우에도
요청이 실패하지 않도록 400을 반환하지 않습니다. 클라이언트는 이 헤더로 스키마 강제 여부를 판별할 수 있습니다.

## 검증 오류

형태가 잘못된 `response_format`은 프로바이더에 도달하기 전에 400으로 거부됩니다.

| 입력 | 응답 |
|------|------|
| 객체가 아님 | `response_format must be an object.` |
| 알 수 없는 `type` | `response_format.type must be one of: text, json_object, json_schema.` |
| `json_schema` 래퍼 누락 | `response_format.json_schema is required and must be an object when type is "json_schema".` |
| `schema`가 객체가 아님 | `response_format.json_schema.schema must be a JSON Schema object.` |

## 관련 문서

- [Tool Bridge Provider](tool-bridge-provider.md) — `tools`/`tool_choice`를 CLI 구조화 출력으로 연결하는 별도 기능
