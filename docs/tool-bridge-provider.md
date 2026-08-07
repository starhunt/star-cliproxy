# Tool Bridge Provider

Tool Bridge는 일반 CLI provider와 분리된 opt-in provider입니다. OpenAI Chat Completions 요청의 `tools`와 `tool_choice`를 Claude/Codex/Grok CLI의 구조화 출력에 연결하고, 결과를 OpenAI `message.tool_calls`로 반환합니다.

기존 `claude`, `codex`, `grok` provider의 동작이나 설정은 바뀌지 않습니다. Tool Bridge는 요청마다 일반 CLI 프로세스를 실행하므로 Codex app-server, Claude Agent SDK, 별도 상주 bridge 서버가 필요하지 않습니다.

> 현재의 별도 provider와 `-tools` alias는 안전 경계와 운영 상태를 명시적으로 표현하는 구현 선택입니다. 반드시 별도 alias여야 하는 것은 아니며, 향후에는 같은 alias 안에서 격리 runner로 자동 분기할 수도 있습니다. 필수인 분리와 선택적인 분리, 구체적인 실패 사례는 [`Tool Bridge 경계 설계 분석`](./tool-bridge-design-analysis.md)을 참고하세요.

## 설정

```yaml
providers:
  claude:
    enabled: true
    cli_path: "claude"
    default_model: "claude-sonnet-4-6"
    max_concurrent: 5
    timeout_ms: 300000
    extra_args: []
  codex:
    enabled: false
    cli_path: "codex"
    default_model: "gpt-5.5"
    timeout_ms: 300000
  grok:
    enabled: true
    cli_path: "grok"
    default_model: "grok-4.5"
    timeout_ms: 300000

tool_bridge_providers:
  claude-tools:
    base_provider: "claude"
    driver: "claude-cli"
    strategy: "structured-output"
    disable_native_tools: true
  codex-tools:
    enabled: true
    base_provider: "codex"
    driver: "codex-cli"
    strategy: "structured-output"
    disable_native_tools: true
  grok-tools:
    base_provider: "grok"
    driver: "grok-cli"
    strategy: "structured-output"
    disable_native_tools: true

model_mappings:
  - alias: "claude-tools"
    provider: "claude-tools"
    actual_model: "claude-sonnet-4-6"
  - alias: "codex-tools"
    provider: "codex-tools"
    actual_model: "gpt-5.5"
  - alias: "grok-tools"
    provider: "grok-tools"
    actual_model: "grok-4.5"
```

각 Tool Bridge는 base provider의 `cli_path`, 모델, timeout, 동시성과 작업 디렉터리를 상속합니다. 일반 provider의 권한·agent 플래그가 섞이지 않도록 `extra_args`는 암묵적으로 상속하지 않으며, 필요한 비관리 플래그만 Tool Bridge 항목에 따로 지정합니다. 같은 필드를 Tool Bridge 항목에 지정하면 해당 인스턴스에서만 덮어씁니다. provider 이름은 기존 provider와 중복될 수 없습니다.

### Tool Bridge 설정 속성

| 속성 | 역할 | 대시보드에서 변경 |
|---|---|---|
| `base_provider` | CLI 경로와 기본 모델 등을 물려받을 기본 provider | 읽기 전용; `config.yaml`에서 변경 |
| `driver` | `claude-cli`, `codex-cli`, `grok-cli` 실행 방식 선택 | 읽기 전용; `config.yaml`에서 변경 |
| `strategy` | OpenAI tool call을 만드는 변환 전략. 현재 `structured-output`만 지원 | 읽기 전용 |
| `disable_native_tools` | CLI 자체의 셸·파일·MCP·브라우저 도구를 차단하고 클라이언트 함수 선택만 허용 | 변경 가능, 기본값·권장값 `true` |
| `enabled` | 해당 bridge를 요청 라우팅에서 활성화 | 변경 가능 |
| `cli_path`, `default_model` | 상속값 대신 이 bridge에서 사용할 CLI와 모델 | 변경 가능 |
| `max_concurrent`, `timeout_ms` | bridge 전용 동시 처리 수와 요청 제한 시간 | 변경 가능 |
| `working_dir`, `extra_args` | bridge 전용 작업 디렉터리와 비관리 추가 인수 | 변경 가능 |

대시보드의 Providers 화면에서는 Tool Bridge가 Plugin/Custom과 분리된 전용 섹션에 표시됩니다. 구조를 결정하는 `base_provider`, `driver`, `strategy`는 실수로 실행 계약을 바꾸지 않도록 읽기 전용이며, 나머지 런타임 속성은 저장 즉시 적용됩니다.

tool-calling 클라이언트에는 `claude-tools`, `codex-tools`, `grok-tools` 요청 모델명을 지정하고, 기존 서비스는 계속 일반 provider에 연결된 요청 모델명을 사용하면 됩니다. base provider가 `enabled: false`여도 Tool Bridge 항목에 `enabled: true`를 지정해 bridge만 독립적으로 활성화할 수 있습니다.

## 기본 provider와 Tool Bridge를 왜 분리하는가

같은 Claude/Codex/Grok CLI를 실행하더라도 맡기는 역할이 다릅니다.

| 구분 | 기본 `claude` / `codex` / `grok` | `claude-tools` / `codex-tools` / `grok-tools` bridge |
|---|---|---|
| 주 역할 | 질문에 일반 답변 생성 | 클라이언트가 제공한 함수 중 호출할 함수 선택 |
| API 반환 | `message.content` 텍스트 | OpenAI 형식의 `message.tool_calls` |
| 도구 실행 주체 | CLI 자체 기능일 수 있음 | ByulOffice 등 요청을 보낸 클라이언트 |
| 대표 사례 | 요약, 번역, 코드 설명 | 셀 읽기, 문서 수정, 슬라이드 생성 |

예를 들어 ByulOffice가 `read_cells` 함수를 요청에 넣고 "A1:B10을 분석해줘"라고 질문했다고 가정합니다. 기본 Codex provider는 "먼저 셀을 읽겠습니다"라는 텍스트를 반환하거나 Codex 자체 도구를 사용하려 할 수 있습니다. ByulOffice가 필요한 응답은 다음과 같은 구조입니다.

```json
{
  "finish_reason": "tool_calls",
  "message": {
    "tool_calls": [{
      "id": "call_123",
      "type": "function",
      "function": {
        "name": "read_cells",
        "arguments": "{\"range\":\"A1:B10\"}"
      }
    }]
  }
}
```

Tool Bridge는 `read_cells`를 직접 실행하지 않습니다. 선택한 CLI 모델이 함수를 고르게 한 뒤 위 호출 정보를 호출자에게 반환하고, 실제 Excel 접근은 ByulOffice 같은 클라이언트가 수행합니다. 이처럼 CLI 자체 도구 권한과 클라이언트 도구 권한의 경계를 분명히 하기 위해 기본 provider와 별도 bridge provider로 둡니다.

## 요청 모델명(`alias`)을 쉽게 이해하기

`alias`는 실제 AI 모델의 새 이름이 아니라 클라이언트가 OpenAI 호환 요청의 `model`에 넣는 **라우팅 이름**입니다.

```json
{
  "model": "codex-tools",
  "messages": [{"role": "user", "content": "A1:B10을 분석해줘"}]
}
```

StarProxy는 이를 다음과 같이 해석합니다.

```text
요청 모델명 codex-tools
  → provider codex-tools 선택
  → 실제 모델 gpt-5.5 실행
```

세 이름의 역할은 다음과 같습니다.

| 이름 | 예시 | 의미 |
|---|---|---|
| 요청 모델명 (`alias`) | `codex-tools` | 클라이언트가 요청의 `model`에 넣는 이름 |
| provider 이름 | `codex-tools` | StarProxy 내부 실행 경로 |
| 실제 모델 (`actual_model`) | `gpt-5.5` | Codex CLI에 전달되는 실제 모델 |

요청 모델명과 provider 이름은 같게 정해 이해하기 쉽게 만들었지만, 기술적으로 반드시 같아야 하는 것은 아닙니다.

### 언제 별도 요청 모델명이 필요한가

- 모든 `gpt-5.5` 요청을 Tool Bridge로 보내도 된다면 기존 `gpt-5.5` 매핑의 provider만 `codex-tools`로 바꿀 수 있습니다.
- 기존 서비스는 일반 Codex를 사용하고 ByulOffice만 Tool Bridge를 사용해야 한다면 StarProxy가 두 실행 경로를 구분할 요청 모델명이 필요합니다.

```yaml
model_mappings:
  # 기존 서비스: 일반 텍스트 응답
  - alias: "gpt-5.5"
    provider: "codex"
    actual_model: "gpt-5.5"

  # tool-calling 클라이언트: OpenAI tool_calls 응답
  - alias: "codex-tools"
    provider: "codex-tools"
    actual_model: "gpt-5.5"
```

두 매핑은 같은 실제 모델을 사용하지만, 클라이언트가 보내는 `model` 값에 따라 일반 응답과 tool call 경로가 나뉩니다.

## 동작과 안전 경계

- Claude driver는 `--output-format json`과 `--json-schema`를 사용합니다.
- Codex driver는 `codex exec --json --ephemeral --output-schema`를 사용합니다. 요청별 임시 디렉터리에 JSON Schema 파일을 권한 `0600`으로 만들고 성공, 오류, 취소, timeout 모두에서 디렉터리 전체를 정리합니다.
- Grok driver는 `--output-format json`, `--json-schema`, `--prompt-file`을 사용합니다. 요청별 권한 `0600` 프롬프트 파일과 빈 작업 디렉터리를 만들고 성공, 오류, 취소, timeout 모두에서 정리합니다.
- `disable_native_tools` 기본값은 `true`입니다. Claude에서는 `--safe-mode`, 빈 MCP 설정의 `--strict-mcp-config`, `--tools ""`, `--no-chrome`, `--disable-slash-commands`, `--no-session-persistence`를 강제합니다.
- Codex에서는 사용자 설정과 rules를 무시하고, 읽기 전용 sandbox와 빈 작업 디렉터리를 사용하며 shell, unified exec, apps, browser, computer use, image generation, multi-agent, plugins 등 native feature를 명시적으로 비활성화합니다. 필수 옵션이나 feature가 없는 Codex 버전은 health check 및 실행에서 fail-closed 처리합니다. 이 동작은 Codex CLI 0.146.0에서 검증했습니다.
- Grok에서는 빈 `--tools` 허용 목록, `--disable-web-search`, `--no-subagents`, `--no-memory`, `--no-plan`, `--permission-mode plan`과 빈 작업 디렉터리를 강제합니다. 프로토콜이나 권한을 바꾸는 `extra_args`는 제거하며, 필수 차단 옵션이 없는 CLI 버전은 health check에서 unhealthy 처리합니다. 이 동작은 Grok CLI 0.2.118에서 검증했습니다.
- Claude의 구조화 출력 자체가 내부 tool round-trip을 사용하므로 `--max-turns 3`을 적용합니다. 이 턴은 클라이언트 함수나 CLI native tool 실행과는 별개입니다.
- 요청의 도구는 CLI가 직접 실행하지 않습니다. Tool Bridge는 도구 이름과 JSON 인자만 반환하며 실제 실행은 ByulOffice 같은 호출자가 담당합니다.
- `tool_choice`의 `none`, `auto`, `required`, 특정 함수 강제를 지원합니다.
- 반환된 함수 이름, JSON 인자, 각 함수의 `parameters` JSON Schema를 서버에서 다시 검증합니다.
- assistant의 이전 `tool_calls`와 후속 `tool` role 결과를 다음 CLI 프롬프트에 보존합니다.
- 구조화 출력은 완성된 JSON 객체 단위이므로 `stream: true`도 CLI 응답 완료 후 OpenAI SSE tool-call 이벤트로 변환됩니다. 텍스트 토큰 단위 실시간 스트리밍은 아니지만, 대기 중 클라이언트 idle timeout을 막기 위해 15초마다 빈 content delta를 heartbeat로 보냅니다.
- Codex driver는 stateless CLI 호출입니다. 실제 tool 사용 흐름은 함수 선택과 tool 결과 후 최종 답변에 각각 한 번씩 `codex exec`가 실행됩니다.

### AGY를 아직 Tool Bridge로 등록하지 않는 이유

AGY 1.1.10은 `--json-schema`와 JSON 출력 자체는 정상 동작합니다. 그러나 Claude의 빈 `--tools` 허용 목록이나 Codex의 feature disable처럼 **CLI native tool 전체를 강제로 끄는 옵션이 없습니다**. `--sandbox --mode plan --disable-slash-commands`를 함께 사용한 실제 구조화 출력 테스트에서도 AGY 내부 `finish` tool action이 실행됐고, 별도 테스트에서는 내부 파일 작업도 발생했습니다.

따라서 현재 `agy-cli` driver를 추가하면 `disable_native_tools: true`라고 표시하면서 실제로는 그 계약을 지키지 못합니다. AGY가 deny-all/빈 allowlist에 해당하는 headless 옵션을 제공하기 전까지는 일반 `agy` provider만 사용하며 `agy-tools`는 등록하지 않습니다. 이 제한은 구조화 출력 형식 문제가 아니라 **도구 실행 주체를 클라이언트로 한정할 수 없는 격리 문제**입니다.

## 로컬 확인

사용할 CLI 로그인을 마친 뒤 서버를 시작하고 아래 요청을 보냅니다. Codex와 Grok을 확인할 때는 모델만 각각 `codex-tools`, `grok-tools`로 바꿉니다.

```bash
curl http://localhost:8300/v1/chat/completions \
  -H "Authorization: Bearer sk-proxy-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-tools",
    "messages": [{"role":"user","content":"서울 날씨를 확인해줘"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "도시의 현재 날씨 조회",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"],
          "additionalProperties": false
        }
      }
    }],
    "tool_choice": "required"
  }'
```

응답의 `choices[0].finish_reason`은 `tool_calls`이고 `choices[0].message.tool_calls[0].function`에 `get_weather`와 JSON 인자가 있어야 합니다. 실제 도구 결과를 같은 `tool_call_id`의 `tool` role 메시지로 추가해 두 번째 요청을 보내면 최종 자연어 답변을 받을 수 있습니다.
