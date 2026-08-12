# Structured Output (`response_format`)

OpenAI Chat Completions의 `response_format`을 받아 프로바이더별 구조화 출력 기능에 연결합니다.
`message.content`에는 스키마를 만족하는 JSON 문자열이 담기므로, Ax(`.useStructured()`)나 OpenAI SDK의
structured output 클라이언트가 그대로 파싱할 수 있습니다.

## 지원 매트릭스

| 프로바이더 | `json_schema` | `json_object` / `text` | 방식 |
|-----------|---------------|------------------------|------|
| `agy` (Antigravity / Gemini) | ✅ | ❌ | `--json-schema` → `structured_output` |
| `claude` (CLI 모드) | ✅ | ❌ | `--json-schema` → `structured_output` |
| `grok` | ✅ | ❌ | `--json-schema` → `structuredOutput` |
| `codex` (CLI 모드) | ✅ | ❌ | `--output-schema <파일>` → 최종 `agent_message` |
| HTTP 프로바이더 (OpenAI 호환) | ✅ | ✅ | 요청 body의 `response_format`을 백엔드로 패스스루 |
| `gemini` CLI, `kimi`, `copilot` | ❌ | ❌ | 무시 (아래 "미지원 프로바이더" 참고) |
| Tool Bridge (`*-tools`) | ❌ | ❌ | 봉투 스키마를 이미 쓰고 있어 무시 (아래 참고) |

검증된 CLI 버전: agy 1.1.12, claude 2.1.228, grok 1.0.3, codex 0.147.0.
CLI가 스키마를 무시하고 구조화 출력 없이 응답하면 프록시가 요청을 실패시키고 다음 폴백 프로바이더로 넘깁니다
— 스키마를 만족하지 않는 텍스트를 구조화 응답으로 넘기지 않기 위해서입니다.

### 모드 제약

| 프로바이더 | 미지원 모드 | 이유 |
|-----------|------------|------|
| `claude` | `sdk`, `channel-worker` | 별도 실행기를 타며 `--json-schema`를 거치지 않음 |
| `codex` | `app-server` | 별도 실행기 |
| `codex` | (세션 재사용) | `codex exec resume`이 `--output-schema`를 지원하지 않아, 스키마 요청은 **resume을 타지 않고 새 exec로 실행**됩니다 |

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
- **스트리밍은 완성된 구조화 값을 1회만 내보냅니다.** CLI별 실측 동작이 제각각이라 통일했습니다:

  | CLI | 스키마 요청 시 delta 실측 |
  |-----|--------------------------|
  | agy | 프로즈(`Blue`) → 스키마 외 필드가 섞인 JSON(`{"answer":"Blue","toolAction":...}`) |
  | claude | 프로즈(`blue`) → 내부 StructuredOutput tool round-trip → 최종 result |
  | grok | JSON 조각(`{"` `answer` `":` `blue` `"}`) — 이어붙이면 유효 |
  | codex | 완성된 `agent_message` 1건 |

  grok처럼 그대로 흘려도 되는 CLI가 있지만, 클라이언트가 프로바이더마다 다른 스트리밍 동작을
  보지 않도록 어느 CLI든 버퍼링 후 1회 emit으로 맞췄습니다.
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

### Tool Bridge 프로바이더

Tool Bridge(`claude-tools`, `codex-tools`, `grok-tools`)는 `tools`/`tool_choice`를 CLI 구조화 출력으로
변환하기 위해 **이미 같은 플래그에 자체 봉투 스키마**(`response_type`/`content`/`tool_calls`)를 쓰고 있습니다.
한 번의 CLI 호출에 스키마는 하나만 줄 수 있으므로, Tool Bridge는 `response_format`을 미지원으로 선언하고
`X-Unsupported-Params`로 알립니다. function calling은 영향받지 않습니다.

```
POST /v1/chat/completions  { model: "claude-tools", tools: [...], response_format: {...} }
→ 200, finish_reason: "tool_calls", tool_calls: [...]
→ X-Unsupported-Params: response_format
```

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
