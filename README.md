[English](./README.md) | [한국어](./README.ko.md)

# star-cliproxy

An OpenAI-compatible API proxy powered by your AI CLI subscriptions - Claude, Codex, Copilot, Gemini, Antigravity, and Grok

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

- **OpenAI-compatible API** — `/v1/chat/completions`, `/v1/images/generations`, and `/v1/models` endpoints
- **Anthropic Messages API** — `/v1/messages` endpoint for native Claude Code / Anthropic SDK support
- **Six CLI providers** - Claude Code, Codex, Copilot CLI, Gemini CLI, Antigravity CLI, Grok Build CLI
- **HTTP providers** — connect any OpenAI-compatible HTTP API (MLX serve, llama.cpp, vLLM, Ollama, LM Studio, etc.) with no wrapper scripts
- **Claude Agent SDK mode** — optional SDK execution for Claude provider with session reuse, fine-grained tool control, and budget limits
- **Plugin system** — extend with custom providers without modifying the main codebase (see [Plugin Guide](./plugins/README.md))
- **Image generation API** — `/v1/images/generations` endpoint (OpenAI Images API compatible)
- **Endpoint types** — providers declare supported types (`chat`, `images`, `tts`, `embeddings`)
- **True SSE streaming** — Claude via stream-json NDJSON pipe, Gemini via real-time delta events, Codex via JSONL event stream
- **Model mapping** — alias-based routing with priority fallback chains
- **Response cache** — SHA-256 hash keying, TTL expiry, X-Cache header
- **Rate limiting** — 3-tier (Global / Provider / API Key), counters persisted in SQLite and restored on server restart
- **Dashboard** — real-time monitoring, model management, API key management
- **Active request tracking** — live view of in-flight requests
- **Test Model** — validate a mapping by making a real CLI call before saving
- **Enhanced health check** — CLI probe is authoritative for recovery; real-time failure detection via request-level monitoring
- **developer role support** — OpenAI `developer` role accepted and normalized to `system` for CLI compatibility
- **Configurable working directory** — per-provider `working_dir` option for agentic CLI tool use (file creation, shell commands)
- **Security** — SHA-256 API key auth, prompt injection prevention, CLI injection prevention, timing-safe comparisons
- **Process teardown** — SIGTERM with 3-second grace period, then SIGKILL fallback
- **Error differentiation** — 504 on timeout, 502 on other errors
- **X-Unsupported-Params header** — notifies callers of parameters the CLI does not support
- **Content parts support** — OpenAI content parts array format (compatible with OpenClaw, LangChain, LiteLLM)
- **Debug capture** — request/response payload capture (global or per-model toggle, view CLI args + raw stdout, copy as curl for HTTP providers)
- **Debug log deletion** — delete individual debug log entries
- **Settings page** — change validation settings at runtime (HTTP body size limit still requires restart)
- **i18n** — English / Korean dashboard localization
- **Dark/Light mode** — theme switching
- **API key regeneration** — regenerate key while keeping the name
- **Request trend chart** — per-model color coding, time range selection (6h–7d), real-time filter
- **Image preview** — automatic image URL detection in debug logs and test results
- **API Guide** — built-in usage guide page

## Prerequisites

- **Node.js** 20 or later
- At least one of the following CLI tools installed and authenticated:

| CLI | Subscription | Install |
|-----|-------------|---------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Claude Pro / Max | `npm install -g @anthropic-ai/claude-code` |
| [Codex](https://github.com/openai/codex) | ChatGPT Plus / Pro | `npm install -g @openai/codex` |
| [Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) | GitHub Copilot | `gh extension install github/gh-copilot` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Google AI Studio | `npm install -g @google/gemini-cli` |
| [Antigravity CLI](https://antigravity.google/) | Google AI Pro / Ultra | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |
| [Grok Build CLI](https://x.ai/cli) | SuperGrok / X Premium+ | `curl -fsSL https://x.ai/cli/install.sh \| bash` |

> **HTTP providers:** Any local server with an OpenAI-compatible API (MLX serve, llama.cpp, vLLM, Ollama, LM Studio) can be added directly from the dashboard — no CLI tool or plugin needed. See [HTTP Providers](#http-providers) below.
>
> **Plugin providers:** You can also create custom CLI-based providers as plugins. See the [Plugin Guide](./plugins/README.md) for details.

Run each CLI tool at least once on its own to complete authentication before starting the proxy.

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/starhunt/star-cliproxy.git
cd star-cliproxy
npm install
npm run build
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

Generate `ADMIN_TOKEN` with a strong random value:

```bash
openssl rand -hex 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Generate `PROXY_API_KEY` with the required `sk-proxy-` prefix:

```bash
echo "sk-proxy-$(openssl rand -hex 24)"
# or
node -e "console.log('sk-proxy-' + require('crypto').randomBytes(24).toString('hex'))"
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
  agy:
    enabled: false    # use Antigravity CLI
    cli_path: "agy"
  grok:
    enabled: true     # xAI Grok Build CLI (grok login required)
    cli_path: "grok"
    default_model: "grok-build"
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

Open `http://localhost:5300` in your browser and enter `ADMIN_TOKEN`:

- **Dashboard** — request statistics, hourly usage, live active request view
- **Models** — manage model mappings (create / edit / delete / test)
- **API Keys** — issue and revoke API keys
- **Rate Limits** — adjust rate limit settings (takes effect immediately)
- **Logs** — browse request logs
- **Providers** — manage built-in CLI, custom CLI, and HTTP providers
- **Debug** — capture and inspect API request/response payloads (global or per-model toggle, copy as curl)
- **Settings** — change validation limits at runtime (HTTP body size limit requires restart)
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

### Claude Code (Native Anthropic API)

```bash
# Use Claude Code directly with star-cliproxy
ANTHROPIC_BASE_URL=http://localhost:8300 \
ANTHROPIC_AUTH_TOKEN=sk-proxy-your-secret-key \
ANTHROPIC_MODEL="claude-opus" \
claude "Hello!"
```

#### Using `localcc` shell function

Add the following to your `.zshrc` (or `.bashrc`) to use Claude Code's full environment with any model mapped in star-cliproxy:

```bash
export LOCAL_CLAUDE_API_KEY="sk-proxy-your-secret-key"

localcc() {
  ANTHROPIC_BASE_URL=http://localhost:8300 \
  ANTHROPIC_AUTH_TOKEN=$LOCAL_CLAUDE_API_KEY \
  ANTHROPIC_MODEL="claude-opus" \
  claude "$@"
}
```

This lets you run `localcc` just like `claude`, but requests are routed through star-cliproxy — so you can use any subscription model (Codex, Gemini, Copilot, etc.) by changing `ANTHROPIC_MODEL` to any alias defined in your model mappings.

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
| `antigravity` | Antigravity | `antigravity` |
| `grok-build` | Grok | `grok-build` |

Mapping the same alias to multiple providers enables **automatic fallback** in priority order.

### Reasoning Effort

Control the underlying CLI's reasoning level (e.g. `gpt-5.5-medium`, `claude-sonnet-high`). Set it once on a mapping, or override per request — applies in CLI mode.

**Option A — bake into a model alias** (`config.yaml` or Dashboard → Models):

```yaml
model_mappings:
  - alias: "gpt-5.5-medium"
    provider: "codex"
    actual_model: "gpt-5.5"
    reasoning_effort: "medium"
  - alias: "gpt-5.5-high"
    provider: "codex"
    actual_model: "gpt-5.5"
    reasoning_effort: "high"
  - alias: "claude-sonnet-high"
    provider: "claude"
    actual_model: "claude-sonnet-4-6"
    reasoning_effort: "high"
```

```bash
curl http://localhost:8300/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.5-high","messages":[{"role":"user","content":"hi"}]}'
```

**Option B — pass `reasoning_effort` per request** (overrides the mapping):

```bash
curl http://localhost:8300/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.5","reasoning_effort":"high","messages":[...]}'
```

Levels: `low` · `medium` · `high` · `xhigh` · `max`. Per-provider mapping:

| Provider | CLI flag injected | Levels supported | Fallback |
|----------|-------------------|------------------|----------|
| Claude | `--effort <level>` | low, medium, high, xhigh, max | none |
| Codex | `-c model_reasoning_effort=<level>` | low, medium, high | `xhigh`/`max` → `high` |
| Copilot | `--effort <level>` | low, medium, high, xhigh | `max` → `xhigh` |
| Gemini | — | (unsupported) | field is ignored |
| Antigravity | none | (unsupported) | field is ignored |
| Grok | — | (unsupported) | field is ignored |

Notes:
- Applies in **CLI mode** only. Codex App Server / Claude SDK modes use their own config channels (`~/.codex/config.toml`, `sdk_options`).
- The Playground has a Reasoning selector (auto-disabled for unsupported providers); Logs / Debug / Dashboard show the active level as a badge.

### Codex CLI Session Reuse (`exec resume`)

Codex CLI's `exec resume <thread_id>` lets a session keep its context between calls. Set `enable_session_reuse: true` on a mapping or in the provider yaml and CLIProxy will:

1. Capture `thread_id` from the first `codex exec --json` response (`{"type":"thread.started","thread_id":"..."}`).
2. Store it in an in-memory `SessionManager` keyed by `clientKey` + model with a TTL (default 30 min).
3. For subsequent requests with the same `clientKey`, swap the command to `codex exec resume <thread_id> --json -`.

```yaml
codex:
  cli_options:
    enable_session_reuse: true   # capture thread_id and resume
    session_ttl_ms: 1800000      # 30 minutes
    # ephemeral is forced to false when enable_session_reuse is true (jsonl must persist for resume)
```

**Session identity (`clientKey`) is resolved as:**
1. `X-Cliproxy-Session-Id` request header (validated `^[A-Za-z0-9._:-]{1,128}$`)
2. API key id (fallback)
3. `"anonymous"`

**Multi-user chat apps must send a distinct `X-Cliproxy-Session-Id` per room/conversation** — same value = same Codex thread = shared context.

> ## 🚨 Operational warning — client changes are required
>
> Enabling `enable_session_reuse: true` on a mapping changes the **wire contract** between your client app and CLIProxy. **You must update the client** to send a unique `X-Cliproxy-Session-Id` per conversation. If you skip this step:
>
> - All requests from the same API key share **one Codex thread** → users see each other's messages
> - You won't notice immediately in dev (single user works fine), but **production multi-user traffic will leak context**
> - This is a **security and quality bug**, not a config typo
>
> Treat this as a deployment checklist item, not an opt-in toggle. The mapping is only the server half; the matching client header is mandatory. See **[docs/client-integration-session-reuse.md](docs/client-integration-session-reuse.md)** for the full checklist (Python/TypeScript examples, multi-user patterns, security caveats, and a hand-off note you can pass to an AI coding agent).

```bash
# First call: cliproxy captures thread_id and returns it in X-Cliproxy-Thread-Id (non-stream only)
curl -i http://localhost:8300/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "X-Cliproxy-Session-Id: chat-room-42" \
  -d '{"model":"gpt-5.5-chat","messages":[{"role":"user","content":"My favourite number is 42."}]}'

# Second call: same Session-Id → cliproxy auto-routes to exec resume
curl http://localhost:8300/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "X-Cliproxy-Session-Id: chat-room-42" \
  -d '{"model":"gpt-5.5-chat","messages":[{"role":"user","content":"What number did I say?"}]}'
```

**Mode comparison**:

| Mode | Context retention | Per-request cost | Stability | Multi-room |
|------|-------------------|------------------|-----------|------------|
| `cli` (default) | ❌ stateless | spawn ~300ms | high | n/a |
| `cli` + `enable_session_reuse` | ✅ via thread_id | spawn ~300ms + jsonl disk | high (resume is stable) | `X-Cliproxy-Session-Id` |
| `app-server` (experimental) | ✅ via long-lived process | low (JSON-RPC) | medium (single process) | per `clientKey` |

### Model-Level Provider Overrides (Codex CLI only — 1st-party)

Override provider yaml options on a per-mapping basis. The same `codex` provider instance can host both a "chat" alias with sessions enabled and a "one-shot" alias that stays ephemeral.

**Whitelist (other keys are dropped with a warning):**
- `cli_options.ephemeral`
- `cli_options.enable_session_reuse`
- `cli_options.session_ttl_ms`
- `extra_args` (replaces — does not append)
- `timeout_ms`
- `working_dir`

```yaml
model_mappings:
  # one-shot alias — uses provider defaults (ephemeral=true, no session reuse)
  - alias: "gpt-5.5"
    provider: "codex"
    actual_model: "gpt-5.5"

  # chat alias — same provider, but session reuse enabled
  - alias: "gpt-5.5-chat"
    provider: "codex"
    actual_model: "gpt-5.5"
    provider_overrides:
      cli_options:
        enable_session_reuse: true
        session_ttl_ms: 3600000   # 1 hour
```

In the Dashboard the form exposes the whitelisted fields under **Provider Overrides** (visible only when the provider is `codex`); leave a field blank to inherit the provider default. Other providers (`claude`, `gemini`, `copilot`, `agy`, `grok`, `http`) currently ignore `provider_overrides`.

## HTTP Providers

Connect any local OpenAI-compatible server directly — no CLI wrapper needed.

### Supported servers

Any server that implements `POST /v1/chat/completions` with the OpenAI API format:

- [MLX serve](https://github.com/ml-explore/mlx-examples) — `mlx_lm.server`
- [llama.cpp](https://github.com/ggml-org/llama.cpp) — `llama-server`
- [vLLM](https://github.com/vllm-project/vllm) — `vllm serve`
- [Ollama](https://ollama.com/) — built-in OpenAI compatibility
- [LM Studio](https://lmstudio.ai/) — local server mode
- [text-generation-webui](https://github.com/oobabooga/text-generation-webui) — OpenAI extension

### Setup

1. Start your local LLM server
2. Open Dashboard → **Providers** → **HTTP Providers** → **+ Add HTTP Provider**
3. Enter the base URL **including `/v1`** (e.g. `http://localhost:8080/v1`)
4. Test connection, then register
5. Add a model mapping (Dashboard → Models) to route requests to it

### Example

```bash
# Start MLX serve
mlx_lm.server --model mlx-community/Llama-3-8B-Instruct-4bit --port 8080

# Register via API (or use the dashboard)
curl -X POST http://localhost:8300/admin/http-providers \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "mlx-local",
    "base_url": "http://localhost:8080/v1",
    "default_model": "mlx-community/Llama-3-8B-Instruct-4bit",
    "display_name": "MLX Local"
  }'

# Add a model mapping
curl -X POST http://localhost:8300/admin/model-mappings \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "alias": "llama3",
    "provider": "mlx-local",
    "actualModel": "mlx-community/Llama-3-8B-Instruct-4bit"
  }'

# Use it
curl http://localhost:8300/v1/chat/completions \
  -H "Authorization: Bearer sk-proxy-your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "llama3", "messages": [{"role": "user", "content": "Hello!"}]}'
```

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
      - "--permission-mode"
      - "bypassPermissions"
    # mode: "sdk"              # "cli" (default) or "sdk" (Agent SDK)
    # sdk_options:             # only used when mode is "sdk"
    #   max_turns: 5
    #   permission_mode: "bypassPermissions"
    #   enable_session_reuse: true
    #   session_ttl_ms: 1800000
    #   max_budget_usd: 1.0
  codex:
    enabled: true
    cli_path: "codex"
    default_model: "gpt-5.4"
    max_concurrent: 2
    timeout_ms: 300000
    extra_args:
      - "--skip-git-repo-check"
      - "--sandbox"
      - "workspace-write"
  gemini:
    enabled: true
    cli_path: "gemini"
    default_model: "gemini-2.5-pro"
    max_concurrent: 2
    timeout_ms: 300000
    extra_args:
      - "--yolo"
    working_dir: "/path/to/project"   # CLI working directory (default: system temp)

rate_limits:
  global:
    rpm: 60                    # requests per minute
    rpd: 1000                  # requests per day
  per_provider:
    claude: { rpm: 20 }
    codex: { rpm: 20 }
    gemini: { rpm: 20 }

# Custom providers (loaded from plugins/ directory)
plugins: []
  # - path: "./plugins/my-image-provider"
  #   config:
  #     cli_path: "my-cli"
  #     default_model: "my-model"
  #     timeout_ms: 120000

validation:
  max_message_count: 800       # maximum messages in array
  max_message_length: 250000   # ~62K tokens
  max_prompt_length: 1000000   # ~250K tokens
  max_response_length: 300000  # ~75K tokens
  body_limit_bytes: 16777216   # 16MB (restart required after change)
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
| `POST` | `/v1/messages` | Bearer / x-api-key | Anthropic Messages API (streaming / non-streaming) |
| `POST` | `/v1/images/generations` | Bearer | Image generation (OpenAI Images API compatible) |
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
| `GET/POST/PUT/DELETE` | `/admin/http-providers` | HTTP provider CRUD |
| `POST` | `/admin/http-providers/test` | Test HTTP provider before registering |
| `GET/PUT` | `/admin/debug` | Debug capture configuration |
| `GET/DELETE` | `/admin/debug-logs` | Debug log management |
| `GET/PUT` | `/admin/settings/validation` | Validation settings |
| `GET` | `/admin/trend` | Hourly trend with model breakdown |
| `POST` | `/admin/api-keys/:id/regenerate` | Regenerate API key |

## Architecture

![Architecture](docs/images/star_cliproxy_architecture_english.svg)

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
├── plugins/              # Custom provider plugins
│   ├── README.md             # Plugin development guide
│   └── example-plugin/       # Working example
├── config.example.yaml
├── docs/PRD.md
└── tests/
```

## Plugin System

Extend star-cliproxy with custom providers — image generators, custom LLM APIs, or any HTTP-based service — without modifying the main codebase.

Plugins live in the `plugins/` directory (gitignored by default) and are loaded dynamically at startup.

See [plugins/README.md](./plugins/README.md) for the full plugin development guide.

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
- Admin API always requires `ADMIN_TOKEN` for dashboard and `/admin` access

## Upgrading

- **Database** — new tables are created automatically; existing databases are fully compatible
- **Schema** — no column changes to existing tables, so no migration is needed
- **Clean start** — delete `data/cliproxy.db` and restart to start fresh
- **Config** — `config.yaml` is in `.gitignore`, so `git pull` will never overwrite it; new config fields fall back to defaults

## Claude Agent SDK Mode

The Claude provider supports an optional **Agent SDK mode** (`mode: "sdk"`) as an alternative to spawning the CLI directly. This uses the [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) package.

### Why use SDK mode?

| | CLI mode (default) | SDK mode |
|---|---|---|
| **Session** | Fresh process per request | Reusable sessions (configurable TTL) |
| **Streaming** | NDJSON line parsing | Native async generator with partial messages |
| **Tool control** | Via `extra_args` | `allowed_tools`, `disallowed_tools`, `canUseTool` |
| **Budget** | Not available | `max_budget_usd` per request |
| **Overhead** | ~50-100ms spawn per request | Same for first request, reused thereafter |

### Setup

1. Install the SDK (already included as a dependency):
   ```bash
   npm install
   ```

2. Set `mode: "sdk"` in `config.yaml`:
   ```yaml
   providers:
     claude:
       enabled: true
       cli_path: "claude"
       mode: "sdk"
       sdk_options:
         max_turns: 5
         permission_mode: "bypassPermissions"
         enable_session_reuse: true
         session_ttl_ms: 1800000    # 30 minutes
         max_budget_usd: 1.0        # optional cost cap
   ```

3. Or toggle it from the **Dashboard → Providers → Claude → Execution Mode**.

### SDK Options

| Option | Default | Description |
|--------|---------|-------------|
| `max_turns` | `5` | Maximum agent turns per request |
| `permission_mode` | `bypassPermissions` | Tool permission policy |
| `allowed_tools` | `[]` | Auto-approved tool list |
| `disallowed_tools` | `[]` | Blocked tool list |
| `max_budget_usd` | — | Per-request cost cap (USD) |
| `session_ttl_ms` | `1800000` | Session lifetime (30 min) |
| `enable_session_reuse` | `true` | Reuse sessions across requests |
| `persist_session` | `false` | Save sessions to disk |

> **Note:** The SDK internally spawns the Claude Code CLI as a subprocess. The `cli_path` setting is still used to locate the binary. Both modes produce identical OpenAI-compatible API responses.

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
