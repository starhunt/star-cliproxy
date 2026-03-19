[English](./README.md) | [한국어](./README.ko.md)

# star-cliproxy

AI CLI 구독 플랜을 활용한 OpenAI 호환 API 프록시 — Claude, Codex, Gemini CLI 지원

![Dashboard](docs/images/dashboard.png)

---

## What is this?

Claude Max, ChatGPT Pro, Google AI Studio Pro 등의 **AI 구독 플랜에 포함된 CLI 도구**를 서브프로세스로 호출하여, **OpenAI 호환 API 엔드포인트**를 로컬에서 제공하는 프록시 서비스입니다.

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

- **OpenAI 호환 API** — `/v1/chat/completions`, `/v1/images/generations`, `/v1/models` 엔드포인트
- **3개 CLI Provider 지원** — Claude Code, Codex, Gemini CLI
- **플러그인 시스템** — 메인 코드 수정 없이 커스텀 프로바이더 추가 가능 ([플러그인 가이드](./plugins/README.md))
- **이미지 생성 API** — `/v1/images/generations` 엔드포인트 (OpenAI Images API 호환)
- **엔드포인트 타입** — 프로바이더가 지원 타입 선언 (`chat`, `images`, `tts`, `embeddings`)
- **실제 SSE 스트리밍** — Claude: stream-json NDJSON 파이프, Gemini: 실시간 delta 이벤트, Codex: JSONL 이벤트 스트림
- **모델 매핑** — alias 기반 라우팅 + priority 폴백 체인
- **응답 캐시** — SHA-256 해시 기반, TTL 만료, X-Cache 헤더 노출
- **Rate Limiting** — 3-tier (Global / Provider / API Key), SQLite 영속화 (서버 재시작 후 카운터 복원)
- **대시보드** — 실시간 모니터링, 모델 관리, API 키 관리
- **활성 요청 추적** — 처리 중인 요청을 실시간 표시
- **Test Model** — 매핑 저장 전 실제 CLI 호출로 검증
- **Health Check 강화** — `--version` 실행 + 최근 요청 이력 복합 판정
- **보안** — API 키 인증(SHA-256), 프롬프트 인젝션 방지, CLI 인젝션 방지, 타이밍 공격 방지
- **프로세스 종료** — SIGTERM 후 3초 대기, 미종료 시 SIGKILL fallback
- **오류 구분** — 타임아웃 504, 기타 에러 502
- **X-Unsupported-Params 헤더** — CLI 미지원 파라미터 고지
- **Content parts 지원** — OpenAI content parts 배열 형식 지원 (OpenClaw, LangChain, LiteLLM 호환)
- **Debug 캡처** — 요청/응답 페이로드 캡처 (전체 또는 모델별 on/off, CLI args + raw stdout 확인)
- **Debug 로그 개별 삭제** — 각 로그 항목별 개별 삭제
- **Settings 페이지** — 런타임 validation 설정 변경 (재시작 없이 즉시 반영)
- **i18n** — 영어/한국어 대시보드 다국어 지원
- **Dark/Light 모드** — 다크/라이트 테마 전환
- **API 키 재생성** — 이름 유지하고 키만 재생성
- **요청 트렌드 차트** — 모델별 색상 구분, 기간 선택 (6h~7d), 실시간 필터
- **이미지 미리보기** — 디버그 로그 및 테스트 결과에서 이미지 URL 자동 감지 후 미리보기 표시
- **API Guide** — 내장 사용 가이드 페이지

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

# 모델 목록
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

- **Dashboard** — 요청 통계, 시간대별 사용량, 활성 요청 실시간 표시
- **Models** — 모델 매핑 관리 (추가/수정/삭제/테스트)
- **API Keys** — API 키 생성/폐기
- **Rate Limits** — Rate Limit 설정 (즉시 반영)
- **Logs** — 요청 로그 조회
- **Debug** — API 요청/응답 페이로드 캡처 및 검사 (전체/모델별 토글)
- **Settings** — validation 제한값 런타임 변경
- **API Guide** — 사용 가이드 + 코드 샘플

## Usage Examples

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8300/v1",
    api_key="sk-proxy-your-secret-key",
)

# 일반 요청
response = client.chat.completions.create(
    model="claude-sonnet",
    messages=[{"role": "user", "content": "Summarize this document"}],
)
print(response.choices[0].message.content)

# 스트리밍
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

### curl (스트리밍)

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

| Alias (클라이언트 전송) | Provider | Actual Model |
|------------------------|----------|-------------|
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

# 커스텀 프로바이더 (plugins/ 디렉토리에서 동적 로드)
plugins: []
  # - path: "./plugins/my-image-provider"
  #   config:
  #     cli_path: "my-cli"
  #     default_model: "my-model"
  #     timeout_ms: 120000

validation:
  max_message_count: 200       # 메시지 배열 최대 수
  max_message_length: 1000000  # 1M 글자 (~250K 토큰)
  max_prompt_length: 4000000   # 4M 글자 (~1M 토큰)
  max_response_length: 1000000 # 1M 글자
  body_limit_bytes: 52428800   # 50MB
```

### Environment Variables

| 변수 | 설명 |
|------|------|
| `ADMIN_TOKEN` | 대시보드 Admin API 인증 토큰 (필수) |
| `PROXY_API_KEY` | 초기 API 키 (첫 실행 시 자동 생성) |

## API Endpoints

### OpenAI 호환 엔드포인트 (:8300)

| Method | Endpoint | Auth | 설명 |
|--------|----------|------|------|
| `POST` | `/v1/chat/completions` | Bearer | Chat completion (스트리밍/일반) |
| `POST` | `/v1/images/generations` | Bearer | 이미지 생성 (OpenAI Images API 호환) |
| `GET` | `/v1/models` | Bearer | 사용 가능한 모델 목록 |
| `GET` | `/health` | - | Health check |

### Admin API (:8300/admin)

| Method | Endpoint | 설명 |
|--------|----------|------|
| `GET/POST/PUT/DELETE` | `/admin/model-mappings` | 모델 매핑 CRUD |
| `GET/POST/PUT/DELETE` | `/admin/api-keys` | API 키 관리 |
| `GET/PUT` | `/admin/rate-limits` | Rate Limit 설정 |
| `GET` | `/admin/providers` | Provider 상태 |
| `POST` | `/admin/test-model` | 모델 테스트 |
| `GET` | `/admin/dashboard` | 대시보드 통합 데이터 |
| `GET` | `/admin/active-requests` | 활성 요청 |
| `GET` | `/admin/stats` | 사용 통계 |
| `GET` | `/admin/logs` | 요청 로그 |
| `GET/PUT` | `/admin/debug` | Debug 캡처 설정 |
| `GET/DELETE` | `/admin/debug-logs` | Debug 로그 관리 |
| `GET/PUT` | `/admin/settings/validation` | Validation 설정 |
| `GET` | `/admin/trend` | 모델별 시간대 트렌드 |
| `POST` | `/admin/api-keys/:id/regenerate` | API 키 재생성 |

## Architecture

```
Client (OpenAI SDK)
    |
    POST /v1/chat/completions
    POST /v1/images/generations
    |
+---+-----------------------------+
|  Fastify Server (:8300)        |
|                                |
|  Auth -> RateLimit -> Cache    |
|              |                 |
|     +--------+--------+        |
|     | Provider Engine  |       |
|     | (fallback chain) |       |
|     +--+------+-----+--+       |
|        |      |     |          |
|     Claude  Codex  Gemini      |
|     (spawn) (spawn) (spawn)    |
|        |                       |
|     Plugins (dynamic load)     |
|     (custom providers)         |
|                                |
|  SQLite (logs, config, cache,  |
|          rate limit counters)  |
+--------------------------------+

+--------------------------------+
|  Dashboard (:5300)             |
|  React + Vite                  |
|  -> Admin API (:8300/admin)    |
+--------------------------------+
```

## Project Structure

```
star-cliproxy/
├── packages/
│   ├── shared/          # 공유 타입, 상수
│   ├── server/          # Backend API (Fastify)
│   │   └── src/
│   │       ├── providers/    # CLI provider 구현체
│   │       ├── routes/       # API 엔드포인트
│   │       ├── middleware/   # Auth, rate-limit, logging
│   │       ├── services/     # Router, queue, cache, health-check
│   │       └── db/           # SQLite + Drizzle ORM
│   └── dashboard/       # Dashboard UI (React + Vite)
│       └── src/
│           ├── pages/        # Dashboard, Models, Keys, Logs, Debug, Settings, Guide
│           ├── i18n/         # 다국어 번역 (EN/KO)
│           └── theme/        # Dark/Light 테마 프로바이더
├── plugins/              # 커스텀 프로바이더 플러그인
│   ├── README.md             # 플러그인 개발 가이드
│   └── example-plugin/       # 동작하는 예제
├── config.example.yaml
├── docs/PRD.md
└── tests/
```

## 플러그인 시스템

메인 코드 수정 없이 커스텀 프로바이더를 추가할 수 있습니다. 이미지 생성기, 커스텀 LLM API, HTTP 기반 서비스 등을 플러그인으로 연동하세요.

플러그인은 `plugins/` 디렉토리에 위치하며 (기본적으로 gitignore 처리), 서버 시작 시 동적으로 로드됩니다.

전체 플러그인 개발 가이드는 [plugins/README.md](./plugins/README.md)를 참고하세요.

## Platform Support

| 플랫폼 | 상태 | 비고 |
|--------|------|------|
| **macOS** | 지원 | 주 개발 플랫폼 |
| **Linux** | 지원 | Node.js 20+ 테스트 완료 |
| **Windows** | 지원 | CLI 도구가 PATH에 등록되어 있어야 함 |

## Security

- API 키는 SHA-256 해시로 저장 (평문 비저장)
- Admin 토큰은 `crypto.timingSafeEqual`로 비교 (타이밍 공격 방지)
- 프롬프트 인젝션 방지 — `<|user|>` / `<|assistant|>` 구분자 sanitize
- CLI 인젝션 방지 (`spawn` 사용, `--` 옵션 종료 마커)
- 입력 null byte 제거
- 메시지 수/길이/총 크기 제한 (설정 가능)
- HTTP 요청 본문 크기 제한
- Admin API는 localhost 접근 허용, 외부 접근 시 토큰 필수

## Upgrading

- **데이터베이스** — 새 테이블은 자동 생성되므로 기존 DB와 호환됩니다
- **스키마** — 기존 테이블에 컬럼 변경이 없으므로 마이그레이션이 필요 없습니다
- **초기화** — `data/cliproxy.db`를 삭제 후 재시작하면 깨끗하게 시작할 수 있습니다
- **설정** — `config.yaml`은 `.gitignore`에 포함되어 `git pull` 시 덮어쓰지 않습니다. 새 설정 필드는 기본값으로 폴백됩니다

## Known Limitations

- **토큰 카운팅** — CLI 제공 시 사용, 미제공 시 추정 (문자수/4)
- **구독 한도** — 각 구독 플랜의 Rate Limit이 적용됨
- **멀티턴** — 대화 히스토리를 텍스트로 직렬화하여 CLI에 전달
- **지원 안 되는 파라미터** — `temperature`, `top_p` 등 OpenAI 파라미터 일부는 CLI에서 미지원 (X-Unsupported-Params 헤더로 고지)
- **Content parts** — `text` 타입만 추출하며, `image_url` 등 비텍스트 파트는 무시됩니다

## License

MIT

## Credits

Built with Claude Code.
