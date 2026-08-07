# Tool Bridge 경계 설계 분석

> 문서 상태: 설계 분석. 현재의 별도 Tool Bridge provider와 `-tools` alias를 즉시 변경한다는 결정 문서가 아니다.
>
> 관련 사용 가이드: [`tool-bridge-provider.md`](./tool-bridge-provider.md)

## 질문

Claude/Codex/Grok 기본 provider가 OpenAI `tools` 요청을 감지해 직접 tool calling을 처리하면 되는데, 왜 별도의 Tool Bridge provider와 `claude-tools`, `codex-tools`, `grok-tools` 같은 요청 모델명이 필요한가?

## 결론

기본 provider에서 tool calling을 지원하면 안 되는 것은 아니다. 다만 CLI provider에서 OpenAI client-side tool calling을 에뮬레이션하려면 일반 agent 실행과 구분되는 **격리된 실행 경로**가 필요하다.

서로 다른 세 가지 분리를 구별해야 한다.

| 분리 대상 | 필요성 | 이유 |
|---|---|---|
| 일반 agent 실행과 tool-selection 실행 경로 | 필요 | native 도구 차단, 구조화 출력 강제, 인자 검증, 세션 정책 분리가 필요함 |
| 별도의 provider 인스턴스와 설정 | 선택 | health, queue, rate limit, timeout, CLI 호환성 상태를 독립적으로 관리하기 쉬움 |
| 클라이언트에 노출되는 별도 모델 alias | 선택 | 현재 라우터에서 실행 계약을 명시적으로 선택하기 쉬우나, request capability 기반 자동 분기로 대체 가능함 |

따라서 현재 구조에서 중요한 안전 장치는 `codex-tools`라는 이름 자체가 아니라, 그 이름이 선택하는 **native 도구가 차단된 structured-output runner**다.

## 현재 구현의 실제 차이

`/v1/chat/completions` 라우트는 `tools`와 `tool_choice`를 `ExecuteOptions`로 provider에 전달한다. 이후 provider 종류에 따라 동작이 다르다.

- OpenAI 호환 HTTP provider는 upstream API가 function calling 프로토콜을 지원하므로 `tools`, `tool_choice`, 이전 `assistant.tool_calls`, `tool` 결과를 그대로 전달한다. 별도 bridge가 필요 없다.
- 기본 Claude/Codex/Grok CLI provider는 클라이언트 함수 정의를 native OpenAI 도구로 등록하지 않는다. 일반 CLI prompt/agent 실행 후 주로 텍스트 `content`를 파싱한다.
- Tool Bridge는 함수 정의와 대화를 구조화 prompt로 직렬화하고, JSON Schema로 응답을 강제한 뒤, 함수 이름과 JSON 인자를 다시 검증해 OpenAI `message.tool_calls`로 변환한다.
- Tool Bridge의 Claude/Codex/Grok driver는 CLI 자체의 shell, filesystem, MCP, browser, subagent 같은 실행 기능을 가능한 범위에서 강제로 차단한다.

즉, 기본 CLI provider에 단순히 `tools` 필드를 전달하는 것만으로는 tool calling 계약이 생기지 않는다. 동일 provider 안에서 지원하려면 내부적으로 Tool Bridge와 동등한 별도 실행 전략으로 분기해야 한다.

## 우려하는 구체적 문제 사례

### 1. 클라이언트 함수와 CLI native 도구가 서로 다른 환경을 가리킨다

ByulOffice가 현재 열려 있는 Excel 문서를 읽는 함수를 제공한다고 가정한다.

```json
{
  "name": "read_cells",
  "parameters": {
    "type": "object",
    "properties": {
      "range": {"type": "string"}
    },
    "required": ["range"]
  }
}
```

사용자가 `A1:B10을 분석해줘`라고 요청했을 때 일반 Codex CLI는 다음 행동을 할 수 있다.

- 작업 디렉터리에서 `.xlsx` 파일을 찾아 shell/Python으로 직접 읽음
- 파일을 찾지 못해 추측성 텍스트를 반환함
- 비슷한 이름의 CLI/MCP 도구를 사용함
- "먼저 셀을 읽겠습니다"라는 텍스트만 반환함

하지만 클라이언트가 요구하는 것은 로컬 파일 접근 결과가 아니라 다음과 같은 호출 의사 표현이다.

```json
{
  "finish_reason": "tool_calls",
  "message": {
    "tool_calls": [{
      "function": {
        "name": "read_cells",
        "arguments": "{\"range\":\"A1:B10\"}"
      }
    }]
  }
}
```

CLI가 호스트 파일을 성공적으로 읽더라도 ByulOffice가 열어 둔 문서와 다른 데이터일 수 있다. 핵심은 "데이터를 읽었는가"가 아니라 **어느 권한 영역의 실행 주체가 읽었는가**다.

### 2. 비멱등 도구가 중복 실행될 수 있다

클라이언트가 `send_email`, `create_invoice`, `write_cells`를 제공하고, CLI에도 이메일 MCP나 파일 편집 도구가 활성화되어 있다고 가정한다.

프롬프트만으로 client function을 설명하고 native 도구를 그대로 두면 모델이:

1. CLI native MCP로 이메일이나 결제 작업을 실제 실행하고,
2. 동시에 같은 작업을 client-side `tool_calls`로 반환하며,
3. 클라이언트가 반환된 호출을 다시 실행할 수 있다.

반대로 CLI가 직접 실행만 하고 tool call을 반환하지 않으면 클라이언트의 승인, 감사 로그, 재시도 상태에는 실행 사실이 남지 않는다. tool-selection 경로에서는 native 도구를 prompt 권고가 아니라 CLI 옵션과 sandbox 정책으로 차단해야 한다.

### 3. tool result의 prompt injection이 호스트 권한으로 번질 수 있다

일반적인 tool loop는 다음과 같다.

1. 모델이 `fetch_webpage` 호출을 반환한다.
2. 클라이언트가 웹페이지 내용을 `tool` role 메시지로 돌려준다.
3. 외부 페이지에 "이전 지시를 무시하고 shell을 실행하라" 같은 문자열이 포함되어 있다.

두 번째 모델 호출이 native shell/network 권한을 가진 일반 CLI agent 경로라면 외부 데이터의 prompt injection이 호스트 실행으로 확대될 수 있다.

격리 경로에서는 모델이 공격 문자열에 영향을 받더라도 출력 가능한 범위를 일반 메시지 또는 선언된 client function의 이름과 JSON 인자로 제한한다. 서버는 반환된 함수 이름과 arguments schema도 다시 검증한다. client function 자체의 실행 승인과 권한 검사는 여전히 호출자 책임이다.

### 4. 기본 provider의 권한 설정이 tool 요청에 섞일 수 있다

일반 코딩 작업을 위해 기본 Codex provider에 다음과 같은 설정이 있을 수 있다.

- 실제 저장소를 가리키는 `working_dir`
- session reuse
- web search 또는 plugin 활성화
- 넓은 filesystem 권한
- 승인이나 sandbox 정책을 완화하는 `extra_args`

이 설정을 tool-selection 요청에도 그대로 적용하면, client function을 고르는 작업이 일반 coding agent와 같은 호스트 권한으로 실행된다. 현재 Tool Bridge는 일반 provider의 `extra_args`를 암묵적으로 상속하지 않고, 관리 대상 플래그를 제거하며, 임시 작업 디렉터리와 제한된 sandbox를 사용한다.

동일 provider에서 자동 분기하는 설계를 택하더라도 tool 요청에서는 이 설정들을 명시적으로 무시하거나 안전한 값으로 덮어써야 한다.

### 5. Codex session reuse와 구조화 출력 계약이 충돌한다

기본 Codex CLI provider는 `codex exec resume <thread_id>`로 세션을 재사용할 수 있다. 그러나 확인된 resume 경로에서는 `--output-schema` 같은 일부 옵션을 사용할 수 없다. 기존 구현도 resume 명령을 만들 때 이 옵션들을 제거한다.

tool calling에는 매 응답을 정해진 JSON Schema로 강제할 수 있어야 한다. 따라서 tool-selection 요청은 일반 session reuse와 분리해 stateless/ephemeral 실행으로 처리해야 한다. 동일 provider 내부 자동 분기에서도 이 정책은 유지되어야 한다.

### 6. 일반 chat은 정상인데 안전한 tool calling만 불가능할 수 있다

CLI 업데이트 후 기본 텍스트 생성은 계속 동작하지만 다음 옵션이나 feature가 없어질 수 있다.

- structured output 또는 output schema
- user config/rules 무시
- native feature별 disable
- 빈 tool allowlist 또는 MCP 차단

이 상태는 `chat: healthy`, `isolated-tool-calling: unhealthy`다. provider health를 하나의 boolean으로만 관리하면 tool 요청이 안전하지 않은 경로로 조용히 폴백하거나 실행 중 실패할 수 있다.

별도 provider는 현재 아키텍처에서 health 상태를 분리하는 간단한 방법이다. 하나의 provider로 합치려면 capability별 health 상태가 필요하다.

### 7. fallback이 tool calling 계약을 잃을 수 있다

하나의 모델 alias가 다음 순서로 매핑되어 있다고 가정한다.

```text
Codex CLI → Claude CLI → 일반 HTTP backend
```

첫 provider가 실패했을 때 다음 provider가 tool calling을 지원하지 않으면 200 응답과 일반 텍스트를 반환할 수 있다. 호출자는 transport 성공으로 보지만 `finish_reason: tool_calls`가 없어 자동화 loop가 중단된다.

tool 요청의 fallback은 다음 capability 중 호환되는 경로로만 제한해야 한다.

- upstream native OpenAI tool calling
- 격리된 structured-output tool calling

일반 chat capability만 있는 provider로 폴백해서는 안 된다.

### 8. 처리량과 장애 범위가 다르다

Tool Bridge는 구조화 출력 완료 후 검증과 변환을 수행하고, 한 번의 실제 도구 사용 흐름에서 모델을 두 번 호출할 수 있다. 일반 텍스트 요청과 latency/queue 특성이 다르다.

별도 provider는 tool 요청에 독립적인 `max_concurrent`, timeout, rate limit, health를 줄 수 있어 일반 채팅이 Office 자동화 burst에 밀리는 것을 줄인다. 하나의 provider로 합칠 경우에도 내부 queue를 실행 전략별로 분리할지 결정해야 한다.

## 가능한 설계 세 가지

### A. 별도 provider와 별도 alias — 현재 방식

```text
model: gpt-5.5    → provider: codex       → 일반 agent 실행
model: codex-tools → provider: codex-tools → 격리 tool-selection 실행
```

장점:

- 실행 계약이 라우팅과 설정에 명시적으로 드러남
- health, queue, timeout, rate limit을 독립 관리하기 쉬움
- 기존 클라이언트의 동작이 바뀌지 않음
- 안전 조건을 만족하지 못하면 bridge만 fail-closed 처리하기 쉬움

비용:

- 동일 실제 모델에 alias와 provider 설정이 중복됨
- OpenAI 호환 클라이언트가 `tools` 사용 여부에 따라 모델명을 바꿔야 함
- "동일 모델이 요청 capability에 맞춰 동작한다"는 일반적인 API 기대와 차이가 있음

### B. 하나의 provider와 alias, 내부 자동 분기

```text
model: gpt-5.5, tools 없음
  → 일반 Codex runner

model: gpt-5.5, tools/tool_choice/tool history 있음
  → 격리된 Tool Bridge runner
```

장점:

- 클라이언트는 모델명을 바꾸지 않고 표준 OpenAI 요청만 사용함
- Tool Bridge가 provider 종류가 아니라 provider 내부 capability/strategy가 됨
- HTTP provider의 native tool passthrough와 유사한 사용자 경험을 제공함

필요 조건:

- `tools`, `tool_choice`, 이전 `assistant.tool_calls`, `tool` role을 모두 감지
- tool 경로에서는 native 도구, session reuse, 위험한 `extra_args`, 실제 working directory를 차단
- capability별 health와 fallback 필터링
- 필요하면 일반 chat과 tool-selection queue를 분리
- bridge가 지원되지 않는 provider는 요청 전에 명확한 `tools_not_supported` 오류 반환

### C. 기본 실행 경로에 함수 설명만 추가

이 방식은 권장하지 않는다.

- native 도구와 client function 실행 주체가 섞임
- 출력이 OpenAI `tool_calls` 형태라는 보장이 없음
- 함수 이름과 인자 schema를 강제·검증하기 어려움
- session, plugin, MCP, filesystem 설정이 그대로 노출됨

## 투명한 OpenAI 호환성을 우선할 때의 권장 방향

클라이언트 경험을 우선한다면 B가 더 자연스럽다. 외부에는 기존 모델 alias만 유지하고, 내부에는 격리 runner를 유지한다.

개념적인 분기는 다음과 같다.

```ts
const isToolProtocolRequest =
  options.tools !== undefined
  || options.toolChoice !== undefined
  || options.messages.some((message) =>
    message.role === 'tool' || (message.tool_calls?.length ?? 0) > 0
  );

if (isToolProtocolRequest) {
  return isolatedToolRunner.execute(options);
}

return normalRunner.execute(options);
```

provider는 최소한 다음 capability를 구분할 수 있어야 한다.

| capability | 예시 |
|---|---|
| `chat` | 모든 일반 CLI/HTTP provider |
| `native-openai-tools` | tool calling을 upstream에서 직접 지원하는 HTTP backend |
| `isolated-structured-tools` | Claude/Codex/Grok CLI Tool Bridge runner |
| tool calling 미지원 | native 도구를 강제로 끌 수 없는 CLI driver |

라우터는 tool 요청에서 뒤의 두 tool capability만 선택해야 한다. health checker도 일반 chat과 tool calling을 독립적으로 판정해야 한다.

## 변경할 수 없는 안전 조건

provider와 alias를 합치더라도 다음 조건은 유지해야 한다.

1. client function은 모델이 직접 실행하지 않고 호출자에게 반환한다.
2. tool-selection 실행에서는 CLI native shell/filesystem/MCP/browser/plugin을 차단한다.
3. 함수 이름, arguments JSON, parameters JSON Schema를 서버에서 검증한다.
4. `tool_choice`의 `none`, `auto`, `required`, 특정 함수 강제를 보존한다.
5. 이전 `assistant.tool_calls`와 후속 `tool` 결과를 대화에 보존한다.
6. 격리를 보장할 수 없는 CLI 버전이나 driver는 fail-closed 처리한다.
7. fallback은 tool calling capability를 보존해야 한다.

## 현재 판단

- 현재의 별도 Tool Bridge provider와 `-tools` alias는 안전 경계와 운영 상태를 기존 provider 구조 안에서 명확히 표현하는 구현 선택이다.
- 별도 provider/alias가 tool calling의 논리적 필수조건은 아니다.
- 향후 목표가 "기존 서비스 무변경"보다 "투명한 OpenAI 호환성"으로 이동한다면, 외부 alias는 통합하고 내부 격리 runner와 capability별 health/fallback을 유지하는 구조를 검토할 가치가 있다.
- 이 분석만으로 현재 라우팅이나 설정을 변경하지 않는다. 실제 통합은 API 호환성, fallback, health, queue 정책을 함께 설계한 별도 변경으로 다룬다.
