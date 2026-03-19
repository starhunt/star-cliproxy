[English](./README.md) | [한국어](./README.ko.md)

# star-cliproxy

An OpenAI-compatible API proxy powered by your AI CLI subscriptions — Claude, Codex, and Gemini

![Dashboard](docs/images/dashboard.png)

---

## What is this?

star-cliproxy spawns **AI CLI tools bundled with your existing subscriptions** (Claude Max, ChatGPT Pro, Google AI Studio Pro) as subprocesses and exposes them as a local **OpenAI-compatible API endpoint**.

Any code already using the OpenAI SDK can switch to star-cliproxy by changing only `base_url` — no additional API costs, just your subscription.

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

- **OpenAI-compatible API** — `/v1/chat/completions` and `/v1/models` endpoints
- **Three CLI providers** — Claude Code, Codex, Gemini CLI
- **True SSE streaming** — Claude via stream-json NDJSON pipe, Gemini via real-time delta events, Codex via JSONL event stream
- **Model mapping** — alias-based routing with priority fallback chains
- **Response cache** — SHA-256 hash keying, TTL expiry, X-Cache header
- **Rate limiting** — 3-tier (Global / Provider / API Key), counters persisted in SQLite and restored on server restart
- **Dashboard** — real-time monitoring, model management, API key management
- **Active request tracking** — live view of in-flight requests
- **Test Model** — validate a mapping by making a real CLI call before saving
- **Enhanced health check** — composite judgment using `--version` probe plus recent request history
- **Security** — SHA-256 API key auth, prompt injection prevention, CLI injection prevention, timing-safe comparisons
- **Process teardown** — SIGTERM with 3-second grace period, then SIGKILL fallback
- **Error differentiation** — 504 on timeout, 502 on other errors
- **X-Unsupported-Params header** — notifies callers of parameters the CLI does not support
- **Content parts support** — OpenAI content parts array format (compatible with OpenClaw, LangChain, LiteLLM)
- **Debug capture** — request/response payload capture (global or per-model toggle, view CLI args + raw stdout)
- **Settings page** — change validation settings at runtime (takes effect immediately without restart)
- **i18n** — English / Korean dashboard localization
- **Dark/Light mode** — theme switching
- **API key regeneration** — regenerate key while keeping the name
- **Request trend chart** — per-model color coding, time range selection (6h–7d), real-time filter
- **API Guide** — built-in usage guide page

## Prerequisites

- **Node.js** 20 or later
- At least one of the following CLI tools installed and authenticated:

| CLI | Subscription | Install |
|-----|-------------|---------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Claude Pro / Max | `npm install -g @anthropic-ai/claude-code` |
| [Codex](https://github.com/openai/codex) | ChatGPT Plus / Pro | `npm install -g @openai/codex` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Google AI Studio | `npm install -g @google/gemini-cli` |

Run each CLI tool at least once on its own to complete authentication before starting the proxy.

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

Edit `.env`:

```env
ADMIN_TOKEN=your-secure-admin-token
PROXY_API_KEY=sk-proxy-your-secret-key
```

Enable or disable providers in `config.yaml`:

```yaml
providers:
  claude:
    enabled: true     # use Claude CLI
    cli_path: "claude"
  codex:
    enabled: true     # use Codex CLI
    cli_path: "codex"
  gemini:
    enabled: false    # disable if not installed
    cli_path: "gemini"
```

### 3. Run

```bash
# Backend API (:8300)
npm run dev

# Dashboard (:5300) — separate terminal
npm run dev:dashboard
```

### 4. Test

```bash
# Health check
curl http://localhost:8300/health

# List models
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

Open `http://localhost:5300` in your browser:

- **Dashboard** — request statistics, hourly usage, live active request view
- **Models** — manage model mappings (create / edit / delete / test)
- **API Keys** — issue and revoke API keys
- **Rate Limits** — adjust rate limit settings (takes effect immediately)
- **Logs** — browse request logs
- **Debug** — capture and inspect API request/response payloads (global or per-model toggle)
- **Settings** — change validation limits at runtime
- **API Guide** — usage guide with code samples

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

Default mappings (add or modify from the dashboard):

| Alias (sent by client) | Provider | Actual Model |
|------------------------|----------|-------------|
| `claude-opus` | Claude | `claude-opus-4-6` |
| `claude-sonnet` | Claude | `claude-sonnet-4-6` |
| `claude-haiku` | Claude | `claude-haiku-4-5-20251001` |
| `gpt-4` | Codex | `gpt-5.4` |
| `gpt-4o` | Codex | `gpt-5.4` |
| `gemini-pro` | Gemini | `gemini-2.5-pro` |
| `gemini-flash` | Gemini | `gemini-2.5-flash` |

Mapping the same alias to multiple providers enables **automatic fallback** in priority order.

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
    max_concurrent: 2          # max simultaneous CLI processes
    timeout_ms: 300000         # 5-minute timeout
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
    rpm: 60                    # requests per minute
    rpd: 1000                  # requests per day
  per_provider:
    claude: { rpm: 20 }
    codex: { rpm: 20 }
    gemini: { rpm: 20 }

validation:
  max_message_count: 200       # maximum messages in array
  max_message_length: 1000000  # 1M chars (~250K tokens)
  max_prompt_length: 4000000   # 4M chars (~1M tokens)
  max_response_length: 1000000 # 1M chars
  body_limit_bytes: 52428800   # 50MB
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ADMIN_TOKEN` | Admin API authentication token for the dashboard (required) |
| `PROXY_API_KEY` | Initial API key (auto-generated on first run if omitted) |

## API Endpoints

### OpenAI-compatible (:8300)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/v1/chat/completions` | Bearer | Chat completion (streaming / non-streaming) |
| `GET` | `/v1/models` | Bearer | List available models |
| `GET` | `/health` | — | Health check |

### Admin API (:8300/admin)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET/POST/PUT/DELETE` | `/admin/model-mappings` | Model mapping CRUD |
| `GET/POST/PUT/DELETE` | `/admin/api-keys` | API key management |
| `GET/PUT` | `/admin/rate-limits` | Rate limit configuration |
| `GET` | `/admin/providers` | Provider status |
| `POST` | `/admin/test-model` | Test a model mapping |
| `GET` | `/admin/dashboard` | Aggregated dashboard data |
| `GET` | `/admin/active-requests` | In-flight requests |
| `GET` | `/admin/stats` | Usage statistics |
| `GET` | `/admin/logs` | Request logs |
| `GET/PUT` | `/admin/debug` | Debug capture configuration |
| `GET/DELETE` | `/admin/debug-logs` | Debug log management |
| `GET/PUT` | `/admin/settings/validation` | Validation settings |
| `GET` | `/admin/trend` | Hourly trend with model breakdown |
| `POST` | `/admin/api-keys/:id/regenerate` | Regenerate API key |

## Architecture

```
Client (OpenAI SDK)
    |
    POST /v1/chat/completions
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
│   ├── shared/          # Shared types and constants
│   ├── server/          # Backend API (Fastify)
│   │   └── src/
│   │       ├── providers/    # CLI provider implementations
│   │       ├── routes/       # API endpoints
│   │       ├── middleware/   # Auth, rate-limit, logging
│   │       ├── services/     # Router, queue, cache, health-check
│   │       └── db/           # SQLite + Drizzle ORM
│   └── dashboard/       # Dashboard UI (React + Vite)
│       └── src/
│           ├── pages/        # Dashboard, Models, Keys, Logs, Debug, Settings, Guide
│           ├── i18n/         # Translations (EN/KO)
│           └── theme/        # Dark/Light theme provider
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

- API keys stored as SHA-256 hashes (plaintext never persisted)
- Admin token compared with `crypto.timingSafeEqual` (timing attack prevention)
- Prompt injection prevention — `<|user|>` / `<|assistant|>` delimiters sanitized
- CLI injection prevention via `spawn` with `--` option terminator
- Null byte stripping on all inputs
- Configurable limits on message count, message length, total prompt size, and response size
- HTTP request body size cap
- Admin API restricted to localhost by default; external access requires the admin token

## Upgrading

- **Database** — new tables are created automatically; existing databases are fully compatible
- **Schema** — no column changes to existing tables, so no migration is needed
- **Clean start** — delete `data/cliproxy.db` and restart to start fresh
- **Config** — `config.yaml` is in `.gitignore`, so `git pull` will never overwrite it; new config fields fall back to defaults

## Known Limitations

- **Token counting** — uses CLI-reported counts when available; falls back to an estimate (characters / 4)
- **Subscription rate limits** — each underlying subscription plan enforces its own limits
- **Multi-turn context** — conversation history is serialized as text and passed to the CLI
- **Unsupported parameters** — some OpenAI parameters (e.g., `temperature`, `top_p`) are not supported by the CLI tools and are surfaced via the `X-Unsupported-Params` response header
- **Content parts** — only `text` type parts are extracted; non-text parts such as `image_url` are ignored

## License

MIT

## Credits

Built with Claude Code.
