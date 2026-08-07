[English](./README.md) | [한국어](./README.ko.md)

# star-cliproxy

> 이미 구독 중인 AI CLI(Claude Max, ChatGPT Pro, Gemini, Copilot, Grok, Antigravity)를 **OpenAI 호환 API** 하나로 묶어줍니다 — 별도 API 키도, 토큰당 과금도 없습니다.

![Dashboard](docs/images/dashboard.png)

## 무엇인가요?

star-cliproxy는 설치된 AI CLI들을 서브프로세스로 실행하고, 단일 로컬 **OpenAI 호환** 엔드포인트(`/v1/chat/completions`, `/v1/messages`, `/v1/models`, `/v1/images/generations`)로 노출합니다.

기존 OpenAI SDK 코드에서 `base_url`만 바꾸면 그대로 동작합니다:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8300/v1", api_key="sk-proxy-...")
client.chat.completions.create(
    model="claude-sonnet",
    messages=[{"role": "user", "content": "안녕하세요!"}],
)
```

## 왜 star-cliproxy인가요?

- 💸 **API 키가 아닌 구독 활용** — 토큰 종량 과금 대신 Claude Max / ChatGPT Pro 등 구독으로 처리됩니다.
- 🔌 **하나의 엔드포인트, 여러 백엔드** — 활성 빌트인 CLI 6종(Claude, Codex, Copilot, Antigravity, Grok, Kimi) **+** OpenAI 호환 HTTP 서버(vLLM, Ollama, MLX, LM Studio) **+** 커스텀 플러그인.
- 🧭 **스마트 라우팅** — 별칭 기반 모델 매핑, 우선순위 폴백 체인, 모델 단위 provider 오버라이드, 세션 재사용(`codex exec resume`).
- ⚙️ **다양한 실행 모드** — `cli`, Claude **Agent SDK**, Codex **app-server**, 그리고 신규 **channel-worker** bridge 모드.
- 📡 **진짜 SSE 스트리밍** — NDJSON/JSONL 이벤트 파이프 그대로 전달 (사후 청크 분할이 아님).
- 📊 **완성형 대시보드** — 실시간 모니터링, Playground, 원본 페이로드 추적, 모델/키 관리, 레이트 리밋, 한/영 + 다크 모드.
- 🔒 **보안 하드닝** — 시작 시 Zod 설정 검증(fail-fast), SHA-256 키 인증, 프롬프트/CLI 인젝션 방지, timing-safe 비교, 시크릿 마스킹.
- 🟣 **Anthropic Messages API** — `/v1/messages`로 네이티브 Claude Code / Anthropic SDK 클라이언트도 연결됩니다.

## 빠른 시작

### ⭐ 가장 쉬운 방법: AI CLI에게 설치를 맡기기

이 저장소는 에이전트형 CLI가 알아서 설치·설정할 수 있도록 구성돼 있습니다. 빈 폴더에서 **Claude Code**나 **Codex**를 열고 이렇게 요청하세요:

> "`https://github.com/starhunt/star-cliproxy`를 클론하고 README를 읽은 뒤, 의존성 설치·빌드, `config.yaml`과 `.env` 생성(강력한 `ADMIN_TOKEN`과 `sk-proxy-`로 시작하는 `PROXY_API_KEY` 발급), 내가 설치한 provider 활성화, 그리고 백엔드와 대시보드 실행까지 해줘."

에이전트가 아래 단계를 대신 수행하고 접속 URL을 알려줍니다.

### 수동 설치

```bash
git clone https://github.com/starhunt/star-cliproxy.git
cd star-cliproxy
npm install && npm run build

cp config.example.yaml config.yaml
cp .env.example .env
# .env: ADMIN_TOKEN + PROXY_API_KEY (반드시 sk-proxy- 로 시작)
node -e "console.log('ADMIN_TOKEN='+require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('PROXY_API_KEY=sk-proxy-'+require('crypto').randomBytes(24).toString('hex'))"

npm run dev            # 백엔드 API → http://localhost:8300
npm run dev:dashboard  # 대시보드   → http://localhost:5300
```

**사전 요구사항:** Node.js 20+ 와 인증된 CLI 1개 이상. 각 CLI를 먼저 단독 실행해 로그인을 완료하세요. Kimi Code 0.29.1 npm 배포판은 별도로 Node.js 22.19+가 필요하며, 아래 공식 설치 스크립트도 사용할 수 있습니다.

## 지원 Provider

| Provider | 구독 | 설치 |
|---|---|---|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Claude Pro / Max | `npm i -g @anthropic-ai/claude-code` |
| [Codex](https://github.com/openai/codex) | ChatGPT Plus / Pro | `npm i -g @openai/codex` |
| [Copilot CLI](https://docs.github.com/en/copilot) | GitHub Copilot | `gh extension install github/gh-copilot` |
| ~~Gemini CLI~~ *(단종)* | — | 아래 **Antigravity CLI** 사용 — Gemini CLI는 Google이 단종 |
| [Antigravity CLI](https://antigravity.google/) | Google AI Pro / Ultra | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |
| [Grok Build CLI](https://x.ai/cli) | SuperGrok / X Premium+ | `curl -fsSL https://x.ai/cli/install.sh \| bash` |
| [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) | Kimi Code 멤버십 / API key | `curl -fsSL https://code.kimi.com/kimi-code/install.sh \| bash` |
| **HTTP** | OpenAI 호환 서버 | 대시보드에서 추가 (vLLM, Ollama, MLX, LM Studio…) |
| **Tool Bridge** | Claude/Codex CLI + 클라이언트측 OpenAI 도구 | [Tool Bridge 가이드](./docs/tool-bridge-provider.md) |
| **Plugin** | 커스텀 CLI | [플러그인 가이드](./plugins/README.md) |

### Antigravity·Grok·Kimi 호환성

| Provider | 검증 버전 | 현재 연동 범위 |
|---|---|---|
| Antigravity (`agy`) | 1.1.7 | Gemini 3.6/3.5 Flash·3.1 Pro effort 변형, Claude Sonnet/Opus, GPT-OSS 매핑; 네이티브 `json`/`stream-json`; input·cache·output·thinking 실제 토큰 사용량 |
| Grok Build (`grok`) | 0.2.112 | `grok-4.5` 및 호환용 `grok-build` 별칭; 네이티브 `json`/`streaming-json`; 실제 토큰 사용량; 800KB 초과 프롬프트의 `--prompt-file` 전달 |
| Kimi Code (`kimi`) | 0.29.1 | `kimi-for-coding`, high-speed, K3, K3-256k 별칭; 네이티브 `stream-json` assistant 단계; K3 `low`/`high`/`max` 추론; 추정 토큰 사용량 |

Antigravity와 Grok은 `low`, `medium`, `high`를 지원해 `xhigh`와 `max` 요청을 `high`로 정규화합니다. Kimi K3는 `low`, `high`, `max`를 사용하므로 `medium`은 `high`, `xhigh`는 `max`로 변환합니다. 모델 매핑 편집기와 Playground에서도 설정할 수 있습니다.

업그레이드 후 최초 기동 시 내장 레거시 매핑을 자동 마이그레이션하고 선별된 Kimi 별칭을 최대 2개까지만 추가하되, 사용자가 만든 매핑은 덮어쓰지 않습니다. Kimi의 `actual_model`은 원시 API 모델 ID가 아니라 `kimi-code/k3` 같은 CLI alias여야 합니다. Kimi `stream-json`에는 토큰 사용량이 없어 프록시는 UTF-8 크기 기반 추정치를 기록합니다. 또한 prompt mode는 Kimi를 자동 권한 모드로 실행하므로 신뢰하지 않는 요청에는 격리된 `working_dir`을 설정하세요.

## 사용법

OpenAI SDK(Python/TS), curl, 네이티브 Claude Code 모두 동작합니다 — base URL과 `sk-proxy-` 키만 설정하면 됩니다.

```bash
# OpenAI 호환 (스트리밍)
curl http://localhost:8300/v1/chat/completions \
  -H "Authorization: Bearer sk-proxy-..." -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet","messages":[{"role":"user","content":"안녕"}],"stream":true}'
```

```bash
# 네이티브 Claude Code → cliproxy (Anthropic Messages API)
ANTHROPIC_BASE_URL=http://localhost:8300 ANTHROPIC_API_KEY=sk-proxy-... claude
```

모델은 **별칭**(예: `claude-sonnet`, `gpt-5`)으로 노출되어 provider + 실제 모델에 매핑됩니다. 매핑·provider·키 관리는 대시보드 또는 Admin API에서 합니다.
내장 초기 카탈로그는 provider당 최대 2개의 매핑만 등록합니다. 모델이나 추론 프리셋이 더 필요하면 대시보드에서 추가할 수 있습니다.

## 실행 모드

| 모드 | Provider | 설명 |
|---|---|---|
| `cli` *(기본)* | 전체 | CLI를 print 모드로 실행 |
| `sdk` | Claude | Claude Agent SDK — 세션 재사용, 도구 제어, 예산 제한 |
| `app-server` | Codex | 영구 JSON-RPC 프로세스 |
| `channel-worker` | Claude | managed bridge로 **interactive** Claude Code 세션 실행 (`claude -p` 미사용), 결과는 MCP 도구로 회수 — 2026‑06‑15 `claude -p`/Agent SDK 빌링 분리를 회피. 대시보드에서 시작/중지. |

## 대시보드 (`:5300`)

실시간 요청 모니터링·추세, **Playground**, 모델 매핑 편집기, provider 설정(실행 모드 + bridge 제어), API 키, 레이트 리밋, 디버그 페이로드 캡처(CLI 인자 + 원본 stdout, curl 복사). 한/영, 다크/라이트.

## 설정

- `config.yaml` — provider, 모델 매핑, 레이트 리밋, validation (시작 시 Zod 검증). [`config.example.yaml`](./config.example.yaml) 참고.
- `.env` — `ADMIN_TOKEN`, `PROXY_API_KEY`.
- 커스텀 provider는 `plugins/`에서 자동 로드.

## 문서

[Tool Bridge](./docs/tool-bridge-provider.md) · [Tool Bridge 설계 분석](./docs/tool-bridge-design-analysis.md) · [플러그인 가이드](./plugins/README.md) · [Provider 아키텍처](./docs/provider-architecture.md) · [세션 재사용](./docs/client-integration-session-reuse.md) · [이미지 생성](./docs/codex-image-generation.md)

## 보안

SHA-256 API 키 인증 · 프롬프트/CLI 인젝션 방지 · timing-safe 비교 · Zod 설정 검증 · 디버그 로그 마스킹·보존. **`.env`는 절대 커밋하지 마세요.**

## 라이선스

MIT. 구독 및 CLI 사용은 각 provider의 이용약관을 따릅니다.

Built with Claude Code.
