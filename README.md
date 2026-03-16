# star-cliproxy

AI CLI Subscription Proxy Service - Claude, Codex, Gemini CLI를 활용한 OpenAI-compatible API 프록시

---

## What is this?

Claude Max, ChatGPT Pro, Google AI Studio Pro 등의 **AI 구독 플랜에 포함된 CLI 도구**를 서브프로세스로 호출하여, **OpenAI-compatible API 엔드포인트**를 로컬에서 제공하는 프록시 서비스입니다.

기존 OpenAI SDK를 사용하는 코드에서 `base_url`만 변경하면 추가 API 비용 없이 구독 내에서 LLM을 호출할 수 있습니다.

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8300/v1",
    api_key="sk-proxy-your-key-here",
)

response = client.chat.completions.create(
    model="claude-sonnet",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

## Features

- **OpenAI-compatible API** - `/v1/chat/completions`, `/v1/models` 엔드포인트
- **3개 CLI Provider 지원** - Claude Code, Codex, Gemini CLI
- **모델 매핑** - alias 기반 라우팅 + priority 폴백 체인
- **대시보드** - 실시간 모니터링, 모델 관리, API 키 관리
- **활성 요청 추적** - 처리 중인 요청을 실시간 표시
- **Test Model** - 매핑 저장 전 실제 CLI 호출로 검증
- **Rate Limiting** - 3-tier (Global / Provider / API Key), 대시보드에서 즉시 변경
- **보안** - API 키 인증(SHA256), CLI 인젝션 방지, 입력 검증, 타이밍 공격 방지
- **SSE 스트리밍** - 실시간 응답 스트리밍 지원
- **API Guide** - 내장 사용 가이드 페이지

## Prerequisites

- **Node.js** 20 이상
- 다음 CLI 도구 중 하나 이상 설치:

| CLI | 구독 | 설치 |
|-----|------|------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Claude Pro / Max | `npm install -g @anthropic-ai/claude-code` |
| [Codex](https://github.com/openai/codex) | ChatGPT Plus / Pro | `npm install -g @openai/codex` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Google AI Studio | `npm install -g @google/gemini-cli` |

각 CLI 도구를 먼저 단독으로 실행하여 인증(로그인)을 완료해 주세요.

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/starhunt/star-cliproxy.git
cd star-cliproxy
npm install
```

### 2. Configuration

```bash
cp config.example.yaml config.yaml
cp .env.example .env
```

`.env` 파일을 수정합니다:

```env
ADMIN_TOKEN=your-secure-admin-token
PROXY_API_KEY=sk-proxy-your-secret-key
```

`config.yaml`에서 사용할 provider를 활성화/비활성화합니다:

```yaml
providers:
  claude:
    enabled: true     # Claude CLI 사용
    cli_path: "claude"
  codex:
    enabled: true     # Codex CLI 사용
    cli_path: "codex"
  gemini:
    enabled: false    # 설치 안 된 경우 비활성화
    cli_path: "gemini"
```

### 3. Run

```bash
# Backend API (:8300)
npm run dev

# Dashboard (:5300) - 별도 터미널
npm run dev:dashboard
```

### 4. Test

```bash
# Health check
curl http://localhost:8300/health

# Model list
curl http://localhost:8300/v1/models \
  -H "Authorization: Bearer sk-proxy-your-secret-key"

# Chat completion
curl http://localhost:8300/v1/chat/completions \
  -H "Authorization: Bearer sk-proxy-your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### 5. Dashboard

브라우저에서 `http://localhost:5300` 접속:

- **Dashboard** - 요청 통계, 시간대별 사용량, 활성 요청 실시간 표시
- **Models** - 모델 매핑 관리 (추가/수정/삭제/테스트)
- **API Keys** - API 키 생성/폐기
- **Rate Limits** - 레이트 리밋 설정 (즉시 반영)
- **Logs** - 요청 로그 조회
- **API Guide** - 사용 가이드 + 코드 샘플

## Usage Examples

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8300/v1",
    api_key="sk-proxy-your-secret-key",
)

# Non-streaming
response = client.chat.completions.create(
    model="claude-sonnet",
    messages=[{"role": "user", "content": "Summarize this document"}],
)
print(response.choices[0].message.content)

# Streaming
stream = client.chat.completions.create(
    model="gemini-pro",
    messages=[{"role": "user", "content": "Write a haiku"}],
    stream=True,
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### TypeScript (OpenAI SDK)

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:8300/v1',
  apiKey: 'sk-proxy-your-secret-key',
});

const response = await client.chat.completions.create({
  model: 'claude-sonnet',
  messages: [{ role: 'user', content: 'Hello' }],
});
console.log(response.choices[0].message.content);
```

### curl (Streaming)

```bash
curl http://localhost:8300/v1/chat/completions \
  -H "Authorization: Bearer sk-proxy-your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet",
    "messages": [{"role": "user", "content": "Tell me a joke"}],
    "stream": true
  }'
```

## Model Mapping

기본 매핑 (대시보드에서 추가/수정 가능):

| Alias (client sends) | Provider | Actual Model |
|----------------------|----------|-------------|
| `claude-opus` | Claude | `claude-opus-4-6` |
| `claude-sonnet` | Claude | `claude-sonnet-4-6` |
| `claude-haiku` | Claude | `claude-haiku-4-5-20251001` |
| `gpt-4` | Codex | `gpt-5.4` |
| `gpt-4o` | Codex | `gpt-5.4` |
| `gemini-pro` | Gemini | `gemini-2.5-pro` |
| `gemini-flash` | Gemini | `gemini-2.5-flash` |

같은 alias에 여러 provider를 매핑하면 priority 순으로 **자동 폴백**됩니다.

## Configuration

### config.yaml

```yaml
server:
  port: 8300
  host: "127.0.0.1"

providers:
  claude:
    enabled: true
    cli_path: "claude"
    default_model: "claude-sonnet-4-6"
    max_concurrent: 2          # 동시 CLI 프로세스 제한
    timeout_ms: 300000         # 5분 타임아웃
    extra_args:
      - "--no-session-persistence"
  codex:
    enabled: true
    cli_path: "codex"
    default_model: "gpt-5.4"
    max_concurrent: 2
    timeout_ms: 300000
    extra_args:
      - "--skip-git-repo-check"
  gemini:
    enabled: true
    cli_path: "gemini"
    default_model: "gemini-2.5-pro"
    max_concurrent: 2
    timeout_ms: 300000

rate_limits:
  global:
    rpm: 60                    # 분당 요청 제한
    rpd: 1000                  # 일당 요청 제한
  per_provider:
    claude: { rpm: 20 }
    codex: { rpm: 20 }
    gemini: { rpm: 20 }

validation:
  max_message_count: 200       # 메시지 배열 최대 수
  max_message_length: 100000   # 개별 메시지 최대 길이
  max_prompt_length: 500000    # 전체 프롬프트 총 길이
  max_response_length: 500000  # 응답 최대 길이
  body_limit_bytes: 10485760   # HTTP 요청 본문 (10MB)
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ADMIN_TOKEN` | 대시보드 Admin API 인증 토큰 (필수) |
| `PROXY_API_KEY` | 초기 API 키 (첫 실행 시 자동 생성) |

## API Endpoints

### OpenAI-compatible (:8300)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/v1/chat/completions` | Bearer | Chat completion (streaming/non-streaming) |
| `GET` | `/v1/models` | Bearer | Available models |
| `GET` | `/health` | - | Health check |

### Admin API (:8300/admin)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET/POST/PUT/DELETE` | `/admin/model-mappings` | 모델 매핑 CRUD |
| `GET/POST/PUT/DELETE` | `/admin/api-keys` | API 키 관리 |
| `GET/PUT` | `/admin/rate-limits` | Rate Limit 설정 |
| `GET` | `/admin/providers` | Provider 상태 |
| `POST` | `/admin/test-model` | 모델 테스트 |
| `GET` | `/admin/dashboard` | 대시보드 통합 데이터 |
| `GET` | `/admin/active-requests` | 활성 요청 |
| `GET` | `/admin/stats` | 사용 통계 |
| `GET` | `/admin/logs` | 요청 로그 |

## Architecture

```
Client (OpenAI SDK)
    │
    POST /v1/chat/completions
    │
┌───▼─────────────────────────┐
│  Fastify Server (:8300)     │
│                             │
│  Auth → RateLimit → Router  │
│           │                 │
│  ┌────────▼────────┐       │
│  │ Provider Engine  │       │
│  │ (fallback chain) │       │
│  └──┬─────┬─────┬──┘       │
│     │     │     │           │
│  Claude Codex Gemini        │
│  (spawn) (spawn) (spawn)   │
│                             │
│  SQLite (logs, config)      │
└─────────────────────────────┘

┌─────────────────────────────┐
│  Dashboard (:5300)          │
│  React + Vite               │
│  → Admin API (:8300/admin)  │
└─────────────────────────────┘
```

## Project Structure

```
star-cliproxy/
├── packages/
│   ├── shared/          # Shared types, constants
│   ├── server/          # Backend API (Fastify)
│   │   └── src/
│   │       ├── providers/    # CLI provider implementations
│   │       ├── routes/       # API endpoints
│   │       ├── middleware/   # Auth, rate-limit, logging
│   │       ├── services/     # Router, queue, health-check
│   │       └── db/           # SQLite + Drizzle ORM
│   └── dashboard/       # Dashboard UI (React + Vite)
│       └── src/
│           └── pages/        # Dashboard, Models, Keys, Logs, Guide
├── config.example.yaml
├── docs/PRD.md
└── tests/
```

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| **macOS** | Supported | Primary development platform |
| **Linux** | Supported | Tested with Node.js 20+ |
| **Windows** | Supported | Requires CLI tools available in PATH |

## Security

- API 키는 SHA-256 해시로 저장 (평문 비저장)
- Admin 토큰은 `crypto.timingSafeEqual`로 비교 (타이밍 공격 방지)
- CLI 인젝션 방지 (`spawn` 사용, `--` 옵션 종료 마커)
- 입력 null byte 제거
- 메시지 수/길이/총 크기 제한 (설정 가능)
- HTTP 요청 본문 크기 제한
- Admin API는 localhost 접근 허용, 외부 접근 시 토큰 필수

## Known Limitations

- **스트리밍**: CLI가 전체 응답을 반환한 후 청크로 분할하는 시뮬레이트 스트리밍 (TTFB는 CLI 응답 완료 후)
- **토큰 카운팅**: CLI 제공 시 사용, 미제공 시 추정 (문자수/4)
- **구독 한도**: 각 구독 플랜의 Rate Limit이 적용됨
- **멀티턴**: 대화 히스토리를 텍스트로 직렬화하여 CLI에 전달

## License

MIT

## Credits

Built with Claude Code.
