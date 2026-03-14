# star-cliproxy PRD (Product Requirements Document)

> AI CLI Subscription Proxy Service
> Version: 1.0.0 | Date: 2026-03-14

---

## 1. Overview

### 1.1 Problem

Claude Max, ChatGPT Pro, Google AI Studio Pro 구독을 보유하고 있지만, 로컬 개발 환경에서 문서 요약/정리 등 LLM 기능이 필요할 때 별도 API 비용이 발생한다. 각 구독에는 CLI 도구(Claude Code, Codex, Gemini CLI)가 포함되어 있으므로, 이를 활용하면 추가 비용 없이 API 호출이 가능하다.

### 1.2 Solution

CLI 도구를 서브프로세스로 호출하여 OpenAI-compatible API를 제공하는 로컬 프록시 서비스. 기존 OpenAI SDK를 사용하는 어떤 클라이언트에서도 `base_url`만 변경하면 즉시 사용 가능.

### 1.3 Key Value

| 항목 | 설명 |
|------|------|
| **비용 절감** | 구독료 내에서 API 호출, 추가 비용 없음 |
| **통합 인터페이스** | 3개 provider를 하나의 OpenAI-compatible API로 통합 |
| **유연한 라우팅** | 모델 매핑 + 자동 폴백으로 가용성 극대화 |
| **모니터링** | 대시보드로 사용량, 건강상태, 로그 실시간 확인 |

---

## 2. Target Users

- 로컬 개발 환경에서 LLM API가 필요한 개인 개발자
- AI 구독(Claude Max, ChatGPT Pro, Google AI Studio Pro)을 보유한 사용자
- OpenAI SDK 기반 도구/스크립트를 사용하는 사용자

---

## 3. Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Runtime** | Node.js 20+ | CLI 도구와 동일 런타임 |
| **Language** | TypeScript 5.x | 타입 안전성, 기존 프로젝트 일관성 |
| **Backend** | Fastify 5.x | JSON 스키마 검증 내장, SSE 스트리밍, 플러그인 아키텍처 |
| **Dashboard** | React 19 + Vite 6 | 경량 SPA, 빠른 HMR |
| **UI** | Tailwind CSS 4 + Radix UI | 유틸리티 기반 스타일링, 접근성 |
| **Database** | SQLite (better-sqlite3) | 로컬 서비스, 제로 설정, 충분한 성능 |
| **ORM** | Drizzle ORM | 타입 안전, 경량, SQLite 지원 |
| **Process Mgmt** | Node.js child_process.spawn | 네이티브, CLI 서브프로세스 관리 |
| **Monorepo** | npm workspaces | 공유 타입, 단순 구조 |
| **Test** | Vitest | 빠른 실행, TypeScript 네이티브 |

---

## 4. Architecture

### 4.1 System Overview

```
                    ┌─────────────────────────────┐
                    │     Client Applications      │
                    │  (OpenAI SDK, curl, etc.)    │
                    └─────────────┬───────────────┘
                                  │
                    POST /v1/chat/completions
                    Authorization: Bearer sk-proxy-xxx
                                  │
                    ┌─────────────▼───────────────┐
                    │   Backend Server (:8300)      │
                    │                               │
                    │  ┌─────────────────────────┐ │
                    │  │ Auth → RateLimit → Log   │ │
                    │  └───────────┬─────────────┘ │
                    │              │                │
                    │  ┌───────────▼─────────────┐ │
                    │  │   Router (Model Mapping) │ │
                    │  │   + Fallback Logic       │ │
                    │  └───┬───────┬─────────┬───┘ │
                    │      │       │         │     │
                    │  ┌───▼──┐┌───▼──┐┌─────▼──┐ │
                    │  │Claude││Codex ││Gemini  │ │
                    │  │Provdr││Provdr││Provider│ │
                    │  └───┬──┘└───┬──┘└────┬───┘ │
                    │      │       │        │      │
                    │  ┌───▼───────▼────────▼───┐ │
                    │  │    Queue Manager        │ │
                    │  │  (per-provider 동시성)   │ │
                    │  └────────────────────────┘ │
                    │              │                │
                    │      ┌──────▼──────┐         │
                    │      │   SQLite    │         │
                    │      │  (logs,     │         │
                    │      │   config)   │         │
                    │      └─────────────┘         │
                    └──────────────────────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
      ┌───────▼───────┐  ┌───────▼───────┐  ┌───────▼───────┐
      │  claude -p     │  │  codex exec   │  │  gemini -p    │
      │  --output-fmt  │  │               │  │  -o json      │
      │  stream-json   │  │               │  │               │
      └───────────────┘  └───────────────┘  └───────────────┘

                    ┌─────────────────────────────┐
                    │   Dashboard UI (:5300)        │
                    │   React + Vite (별도 프로세스) │
                    │                               │
                    │   → Admin API (:8300/admin)   │
                    └─────────────────────────────┘
```

### 4.2 Directory Structure

```
star-cliproxy/
├── package.json                  # 루트 workspace
├── tsconfig.base.json
├── config.example.yaml
├── .env.example
│
├── packages/
│   ├── shared/                   # 공유 타입, 상수
│   │   └── src/
│   │       ├── types/
│   │       │   ├── api.ts        # OpenAI API 호환 타입
│   │       │   ├── provider.ts   # Provider 인터페이스
│   │       │   ├── config.ts     # 설정 타입
│   │       │   └── database.ts   # DB 스키마 타입
│   │       ├── constants.ts
│   │       └── index.ts
│   │
│   ├── server/                   # Backend API (:8300)
│   │   └── src/
│   │       ├── index.ts          # 엔트리포인트
│   │       ├── app.ts            # Fastify 앱 팩토리
│   │       ├── config/           # YAML/env 설정 로드
│   │       ├── db/               # SQLite + Drizzle
│   │       ├── routes/
│   │       │   ├── v1/           # OpenAI-compatible
│   │       │   │   ├── chat-completions.ts
│   │       │   │   └── models.ts
│   │       │   └── admin/        # 대시보드용 관리 API
│   │       │       ├── model-mappings.ts
│   │       │       ├── api-keys.ts
│   │       │       ├── providers.ts
│   │       │       ├── rate-limits.ts
│   │       │       ├── logs.ts
│   │       │       └── stats.ts
│   │       ├── providers/
│   │       │   ├── base-provider.ts
│   │       │   ├── claude-provider.ts
│   │       │   ├── codex-provider.ts
│   │       │   ├── gemini-provider.ts
│   │       │   ├── provider-registry.ts
│   │       │   └── output-parser.ts
│   │       ├── middleware/
│   │       │   ├── auth.ts
│   │       │   ├── rate-limiter.ts
│   │       │   └── request-logger.ts
│   │       ├── services/
│   │       │   ├── router.ts         # 모델 → Provider 라우팅
│   │       │   ├── queue.ts          # 동시실행 제한
│   │       │   ├── cache.ts          # 요청/응답 캐싱
│   │       │   ├── health-checker.ts
│   │       │   └── stats-collector.ts
│   │       └── utils/
│   │           ├── stream-transformer.ts
│   │           └── message-converter.ts
│   │
│   └── dashboard/                # Dashboard UI (:5300)
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── api/client.ts     # Admin API 클라이언트
│       │   ├── components/
│       │   ├── pages/
│       │   │   ├── DashboardPage.tsx
│       │   │   ├── ModelMappingsPage.tsx
│       │   │   ├── ApiKeysPage.tsx
│       │   │   ├── ProvidersPage.tsx
│       │   │   ├── LogsPage.tsx
│       │   │   └── SettingsPage.tsx
│       │   ├── hooks/
│       │   └── store/
│       ├── index.html
│       └── vite.config.ts
│
├── docs/
│   └── PRD.md
│
└── tests/
    ├── unit/
    └── integration/
```

### 4.3 Data Flow

#### Non-Streaming

```
Client → POST /v1/chat/completions {stream: false}
  → Auth middleware (API key 검증)
  → Rate limiter (한도 확인)
  → Router (model alias → provider + actual_model)
  → Cache check (히트 시 즉시 반환)
  → Queue (provider별 동시실행 제한)
  → Provider.execute()
    → messages → prompt 변환
    → spawn("claude", ["-p", prompt, "--output-format", "json"])
    → stdout 수집 → OpenAI 응답 형식 변환
  → Cache store
  → 로그 기록
  → 응답 반환
```

#### Streaming (SSE)

```
Client → POST /v1/chat/completions {stream: true}
  → Auth → RateLimit → Router → Queue
  → Provider.executeStream()
    → spawn("claude", ["-p", prompt, "--output-format", "stream-json"])
    → stdout (NDJSON lines)
    → StreamTransformer (line → OpenAI SSE chunk)
    → Response stream
      data: {"choices":[{"delta":{"content":"Hello"}}]}
      data: {"choices":[{"delta":{"content":" world"}}]}
      data: [DONE]
```

---

## 5. Provider Specifications

### 5.1 Provider Interface

```typescript
abstract class BaseProvider {
  abstract readonly name: string;
  abstract readonly supportedModels: string[];

  abstract execute(options: ExecuteOptions): Promise<ExecuteResult>;
  abstract executeStream(options: ExecuteOptions): AsyncIterable<StreamChunk>;
  abstract checkHealth(): Promise<HealthStatus>;

  protected buildArgs(options: ExecuteOptions): string[];
  protected spawnProcess(args: string[]): ChildProcess;
  protected convertMessages(messages: OpenAIMessage[]): string;
}
```

### 5.2 CLI Invocation

| Provider | Non-Streaming | Streaming |
|----------|--------------|-----------|
| **Claude** | `claude -p "<prompt>" --output-format json --model <model> --max-turns 1` | `claude -p "<prompt>" --output-format stream-json --model <model>` |
| **Codex** | `codex exec "<prompt>" -m <model>` | stdout 청크 단위 읽기 |
| **Gemini** | `gemini -p "<prompt>" -o json -m <model>` | `gemini -p "<prompt>" -o stream-json -m <model>` |

### 5.3 System Prompt Handling

| Provider | 방법 |
|----------|------|
| **Claude** | `--system-prompt "<system>"` 플래그로 분리 |
| **Codex** | 프롬프트 상단에 `[System] ...` 형태로 포함 |
| **Gemini** | 프롬프트 상단에 `[System] ...` 형태로 포함 |

### 5.4 Message Conversion

OpenAI messages 배열을 CLI 단일 프롬프트로 변환:

```
# Input
messages: [
  {role: "system", content: "You are helpful."},
  {role: "user", content: "Hello"},
  {role: "assistant", content: "Hi!"},
  {role: "user", content: "What is 2+2?"}
]

# Output (Claude: system은 --system-prompt로 분리)
[User] Hello
[Assistant] Hi!
[User] What is 2+2?

# Output (Codex/Gemini: system 포함)
[System] You are helpful.

[User] Hello
[Assistant] Hi!
[User] What is 2+2?
```

### 5.5 Stream Output Parsing

**Claude stream-json:**
```jsonl
{"type":"assistant","subtype":"text_delta","text":"Hello"}
{"type":"result","subtype":"success","result":"Hello world","duration_ms":1234}
```

**Codex exec:**
stdout plain text → 청크 단위로 읽어 delta 변환

**Gemini stream-json:**
```jsonl
{"type":"text_delta","content":"Hello"}
{"type":"turn_complete","content":"Hello world"}
```

### 5.6 Fallback Logic

```
요청: model="gpt-4"
  → model_mappings에서 alias="gpt-4" 조회
  → priority순 정렬: [{provider: "codex", priority: 0}, {provider: "claude", priority: 1}]
  → codex 시도
    → 실패 (timeout/error/unhealthy)
    → claude로 폴백
    → 성공 → 응답 반환 (X-Fallback-Provider 헤더 포함)
```

---

## 6. Database Schema

### 6.1 Tables

```sql
-- API 키 관리
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,      -- SHA-256 해시
  key_prefix TEXT NOT NULL,           -- 앞 12자 (표시용)
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  rate_limit_rpm INTEGER,             -- NULL = 글로벌 설정 사용
  rate_limit_rpd INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT,
  expires_at TEXT
);

-- 모델 매핑
CREATE TABLE model_mappings (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL,                -- 클라이언트 요청 모델명
  provider TEXT NOT NULL,             -- "claude" | "codex" | "gemini"
  actual_model TEXT NOT NULL,         -- CLI에 전달할 실제 모델명
  display_name TEXT,
  priority INTEGER DEFAULT 0,        -- 폴백 우선순위 (낮을수록 우선)
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 요청 로그
CREATE TABLE request_logs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  api_key_id TEXT REFERENCES api_keys(id),
  model_alias TEXT NOT NULL,
  provider TEXT NOT NULL,
  actual_model TEXT NOT NULL,
  status TEXT NOT NULL,               -- success | error | timeout | cancelled
  status_code INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  latency_ms INTEGER,
  ttfb_ms INTEGER,                    -- Time To First Byte
  is_stream INTEGER DEFAULT 0,
  error_message TEXT,
  request_hash TEXT,                  -- 캐시 키용 해시
  created_at TEXT DEFAULT (datetime('now'))
);

-- 응답 캐시
CREATE TABLE response_cache (
  request_hash TEXT PRIMARY KEY,
  model_alias TEXT NOT NULL,
  provider TEXT NOT NULL,
  response_body TEXT NOT NULL,        -- JSON 직렬화
  token_count INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Provider 상태
CREATE TABLE provider_health (
  provider TEXT PRIMARY KEY,
  status TEXT DEFAULT 'unknown',      -- healthy | unhealthy | unknown
  last_check_at TEXT,
  last_success_at TEXT,
  consecutive_failures INTEGER DEFAULT 0,
  error_message TEXT
);

-- 설정 (키-값)
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### 6.2 Indexes

```sql
CREATE INDEX idx_logs_created_at ON request_logs(created_at);
CREATE INDEX idx_logs_provider ON request_logs(provider);
CREATE INDEX idx_logs_status ON request_logs(status);
CREATE INDEX idx_mappings_alias ON model_mappings(alias);
CREATE INDEX idx_cache_expires ON response_cache(expires_at);
```

---

## 7. API Specifications

### 7.1 OpenAI-Compatible API (:8300)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/chat/completions` | Chat completion (streaming/non-streaming) |
| `GET` | `/v1/models` | 사용 가능한 모델 목록 (model_mappings 기반) |
| `GET` | `/v1/models/:id` | 모델 상세 정보 |
| `GET` | `/health` | 서버 건강 상태 |

**POST /v1/chat/completions**

Request:
```json
{
  "model": "gpt-4",
  "messages": [
    {"role": "system", "content": "You are helpful."},
    {"role": "user", "content": "Hello"}
  ],
  "stream": true,
  "max_tokens": 4096,
  "temperature": 0.7
}
```

Response (non-streaming):
```json
{
  "id": "chatcmpl-proxy-xxx",
  "object": "chat.completion",
  "created": 1710000000,
  "model": "gpt-4",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "Hello!"},
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 5,
    "total_tokens": 15
  }
}
```

Response (streaming SSE):
```
data: {"id":"chatcmpl-proxy-xxx","object":"chat.completion.chunk","created":1710000000,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-proxy-xxx","object":"chat.completion.chunk","created":1710000000,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: [DONE]
```

### 7.2 Admin API (:8300/admin)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/model-mappings` | 모델 매핑 목록 |
| `POST` | `/admin/model-mappings` | 매핑 생성 |
| `PUT` | `/admin/model-mappings/:id` | 매핑 수정 |
| `DELETE` | `/admin/model-mappings/:id` | 매핑 삭제 |
| `GET` | `/admin/api-keys` | API 키 목록 (prefix만 노출) |
| `POST` | `/admin/api-keys` | 키 생성 (생성 시에만 전체 키 반환) |
| `PUT` | `/admin/api-keys/:id` | 키 설정 수정 |
| `DELETE` | `/admin/api-keys/:id` | 키 폐기 |
| `GET` | `/admin/providers` | Provider 목록 + 건강상태 |
| `PUT` | `/admin/providers/:name` | Provider 설정 수정 |
| `POST` | `/admin/providers/:name/health-check` | 건강 체크 트리거 |
| `GET` | `/admin/stats` | 사용 통계 |
| `GET` | `/admin/stats/timeseries` | 시계열 데이터 |
| `GET` | `/admin/logs` | 요청 로그 (페이지네이션) |
| `GET` | `/admin/logs/:id` | 로그 상세 |
| `GET` | `/admin/settings` | 전체 설정 |
| `PUT` | `/admin/settings` | 설정 수정 |
| `POST` | `/admin/cache/clear` | 캐시 비우기 |
| `GET` | `/admin/cache/stats` | 캐시 통계 |

Admin API 인증: `X-Admin-Token` 헤더 또는 localhost 접근 제한.

---

## 8. Configuration

### 8.1 config.yaml

```yaml
server:
  port: 8300
  host: "127.0.0.1"
  cors:
    origins: ["http://localhost:5300"]

dashboard:
  port: 5300
  host: "127.0.0.1"

database:
  path: "./data/cliproxy.db"

auth:
  enabled: true
  admin_token: "${ADMIN_TOKEN}"
  initial_keys:
    - name: "default"
      key: "${PROXY_API_KEY}"

providers:
  claude:
    enabled: true
    cli_path: "claude"
    default_model: "sonnet"
    max_concurrent: 2
    timeout_ms: 300000
    extra_args:
      - "--no-session-persistence"
      - "--permission-mode"
      - "bypassPermissions"
  codex:
    enabled: true
    cli_path: "codex"
    default_model: "o4-mini"
    max_concurrent: 2
    timeout_ms: 300000
    extra_args:
      - "--dangerously-bypass-approvals-and-sandbox"
  gemini:
    enabled: true
    cli_path: "gemini"
    default_model: "gemini-2.5-pro"
    max_concurrent: 2
    timeout_ms: 300000
    extra_args:
      - "--approval-mode"
      - "yolo"

rate_limits:
  global:
    rpm: 60
    rpd: 1000
  per_provider:
    claude: { rpm: 20 }
    codex: { rpm: 20 }
    gemini: { rpm: 20 }

cache:
  enabled: true
  ttl_seconds: 3600            # 기본 1시간
  max_entries: 1000
  # 캐시는 동일 messages + model에 대해 해시 기반 매칭

model_mappings:                # DB에 없을 때 시드 데이터
  - alias: "gpt-4"
    provider: "codex"
    actual_model: "o4-mini"
  - alias: "gpt-4o"
    provider: "codex"
    actual_model: "o4-mini"
  - alias: "claude-sonnet"
    provider: "claude"
    actual_model: "sonnet"
  - alias: "claude-opus"
    provider: "claude"
    actual_model: "opus"
  - alias: "gemini-pro"
    provider: "gemini"
    actual_model: "gemini-2.5-pro"
  - alias: "gemini-flash"
    provider: "gemini"
    actual_model: "gemini-2.5-flash"
```

### 8.2 .env

```
ADMIN_TOKEN=your-admin-token-here
PROXY_API_KEY=sk-proxy-your-key-here
```

---

## 9. Dashboard UI

### 9.1 Pages

#### Dashboard (메인)
- 요약 카드: 총 요청수, 성공률, 평균 레이턴시, 캐시 히트율
- Provider 건강 상태 표시 (● Healthy / ○ Unhealthy)
- 최근 24시간 요청 타임라인 차트
- 최근 요청 목록 (실시간 업데이트)

#### Model Mappings
- 매핑 테이블: Alias, Provider, Actual Model, Priority, Status
- 추가/수정/삭제 다이얼로그
- 드래그로 우선순위 변경
- Provider별 필터링

#### API Keys
- 키 목록: Name, Prefix, Rate Limit, Last Used, Status
- 키 생성 다이얼로그 (생성 시 전체 키 표시, 이후 prefix만)
- 활성/비활성 토글
- 개별 레이트 리밋 설정

#### Stats
- 시계열 차트: 분당 요청수, 레이턴시 분포
- Provider별 사용량 파이 차트
- 모델별 사용량 막대 차트
- 토큰 사용량 추이

#### Logs
- 필터: 날짜 범위, Provider, Status, Model
- 테이블: 시간, 모델, Provider, Status, 레이턴시
- 상세 모달: 요청/응답 전문, 에러 상세

#### Settings
- 글로벌 레이트 리밋 설정
- Provider CLI 경로 설정
- 캐시 설정 (TTL, 최대 항목수, 비우기)
- 로그 보존 기간 설정

---

## 10. Core Features Detail

### 10.1 Authentication

- API 키 형식: `sk-proxy-{random32}`
- SHA-256 해시로 저장, prefix(12자)만 조회용
- `Authorization: Bearer sk-proxy-xxx` 헤더로 전달
- 미인증 시 401 반환 (OpenAI 에러 형식)

### 10.2 Rate Limiting

- 3계층: 글로벌 → Provider별 → API 키별
- 슬라이딩 윈도우 방식 (인메모리, 재시작 시 초기화)
- 초과 시 429 + `Retry-After` 헤더
- 대시보드에서 실시간 조정 가능

### 10.3 Request/Response Caching

- 해시 키: SHA-256(model + messages JSON)
- stream=true 요청은 캐시하지 않음 (non-streaming만)
- TTL 기반 만료 (기본 1시간, 설정 가능)
- 캐시 히트 시 `X-Cache: HIT` 헤더 추가
- 대시보드에서 캐시 통계 확인 및 수동 비우기

### 10.4 Health Check

- 주기적으로 각 provider CLI `--version` 실행
- 3회 연속 실패 시 unhealthy 마킹
- unhealthy provider로 라우팅 시도 시 즉시 스킵 (폴백으로)
- 복구 확인 시 자동으로 healthy 전환
- 대시보드에서 수동 트리거 가능

### 10.5 Queue Management

- `p-queue` 라이브러리로 provider별 동시실행 제한
- 기본 max_concurrent: 2 (CLI 프로세스 무거움)
- 큐 대기 상태 대시보드에서 확인 가능
- 타임아웃 시 프로세스 kill + 에러 반환

---

## 11. Error Handling

### 11.1 Error Categories

| Category | HTTP | OpenAI Error Type | Recovery |
|----------|------|-------------------|----------|
| 인증 실패 | 401 | `invalid_api_key` | 유효한 키로 재시도 |
| 레이트 리밋 | 429 | `rate_limit_exceeded` | Retry-After 후 재시도 |
| 모델 없음 | 400 | `model_not_found` | 유효한 모델명 사용 |
| Provider 에러 | 502 | `provider_error` | 폴백 또는 재시도 |
| CLI 미설치 | 503 | `service_unavailable` | CLI 설치 필요 |
| 타임아웃 | 504 | `timeout` | 재시도 또는 짧은 프롬프트 |
| 서버 에러 | 500 | `internal_error` | 로그 확인 |

### 11.2 Error Response Format

```json
{
  "error": {
    "message": "Rate limit exceeded. Please retry after 30 seconds.",
    "type": "rate_limit_error",
    "param": null,
    "code": "rate_limit_exceeded"
  }
}
```

---

## 12. Security

| 항목 | 방법 |
|------|------|
| API 키 저장 | SHA-256 해시, 평문 비저장 |
| Admin API | `X-Admin-Token` 또는 localhost 제한 |
| CORS | Dashboard origin만 허용 |
| 프로세스 격리 | CLI를 제한된 작업 디렉토리에서 실행 |
| 입력 검증 | Fastify JSON Schema 검증 |
| 로그 마스킹 | 프롬프트 내용은 로그에 저장하지 않음 |

---

## 13. Implementation Phases

### Phase 1: Core MVP (Backend)
1. 프로젝트 초기화 (monorepo, tsconfig, eslint, vitest)
2. `packages/shared` - 공유 타입 정의
3. `packages/server` - Fastify 기본 구조
4. SQLite + Drizzle 셋업
5. BaseProvider 추상 클래스
6. ClaudeProvider 구현 (첫 번째 provider)
7. `/v1/chat/completions` (non-streaming + streaming)
8. `/v1/models` 엔드포인트
9. API 키 인증 미들웨어
10. 테스트

### Phase 2: Multi-Provider + Features
11. CodexProvider 구현
12. GeminiProvider 구현
13. Model Mapping + Router + Fallback
14. Queue 관리 (p-queue)
15. Rate Limiting
16. Health Checker
17. Request/Response 캐싱
18. 테스트

### Phase 3: Dashboard
19. Dashboard 프로젝트 초기화 (Vite + React)
20. Admin API 엔드포인트
21. Dashboard 메인 (통계)
22. Model Mappings 페이지
23. API Keys 페이지
24. Logs 페이지
25. Settings 페이지

### Phase 4: Polish
26. 에러 처리 강화
27. 로그 보존/정리 정책
28. 전체 테스트 커버리지
29. README 문서화

---

## 14. Usage Example

```typescript
// OpenAI SDK를 사용하는 기존 코드 — base_url만 변경
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:8300/v1',
  apiKey: 'sk-proxy-your-key-here',
});

// Claude 사용
const response = await client.chat.completions.create({
  model: 'claude-sonnet',
  messages: [{ role: 'user', content: '이 문서를 요약해줘' }],
});

// Codex 사용 (gpt-4 alias → codex/o4-mini로 라우팅)
const response2 = await client.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: true,
});

for await (const chunk of response2) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

---

## 15. Existing Projects Reference

| 프로젝트 | Stars | 언어 | 지원 Provider | 특징 |
|----------|-------|------|--------------|------|
| CLIProxyAPI | 16.3k | Go | Claude, Codex, Gemini + 기타 | 멀티계정, 로드밸런싱 |
| AIClient-2-API | 5.4k | Node+Go | Gemini, Qwen, Grok + 기타 | 웹 UI, 계정 풀 |
| claude-max-api-proxy | 157 | TS | Claude | subprocess spawn, OpenAI 호환 |
| geminicli2api | 544 | Python | Gemini | OAuth 재사용, FastAPI |
| ccNexus | 775 | - | Claude, Codex | 엔드포인트 로테이션 |

star-cliproxy의 차별점:
- **3대 CLI 통합** + **대시보드** + **모델 매핑 UI** + **캐싱** + **폴백** 을 하나의 TypeScript 프로젝트로
- 개인 사용에 최적화된 단순한 구조

---

## 16. Known Limitations

| 제한사항 | 이유 | 완화 방법 |
|---------|------|----------|
| 멀티턴 대화 품질 | CLI는 단일 프롬프트 → 대화 히스토리를 텍스트로 직렬화 | 최대한 자연스러운 포맷 사용 |
| 토큰 카운팅 정확도 | CLI마다 토큰 정보 제공 방식 다름 | CLI 제공 시 사용, 미제공 시 추정 (문자수/4) |
| 구독 한도 | 각 구독별 Rate Limit 존재 | 사용량 추적 + 폴백으로 분산 |
| 응답 레이턴시 | CLI spawn 오버헤드 | 프로세스 풀링 검토 (향후) |
| Codex 스트리밍 | 구조화된 스트리밍 출력 없음 | stdout 청크 단위 읽기로 대응 |
