[English](./README.md) | [한국어](./README.ko.md)

# star-cliproxy

> Turn the AI CLI **subscriptions you already pay for** (Claude Max, ChatGPT Pro, Gemini, Copilot, Grok, Antigravity) into one **OpenAI-compatible API** — no extra API keys, no per-token billing.

![Dashboard](docs/images/dashboard.png)

## What is this?

star-cliproxy runs your installed AI CLIs as subprocesses and exposes them behind a single local **OpenAI-compatible** endpoint (`/v1/chat/completions`, `/v1/messages`, `/v1/models`, `/v1/images/generations`).

Point any OpenAI SDK at it — change only `base_url`, keep your code:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8300/v1", api_key="sk-proxy-...")
client.chat.completions.create(
    model="claude-sonnet",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

## Why star-cliproxy?

- 💸 **Subscriptions, not API keys** — bill against Claude Max / ChatGPT Pro / etc. instead of metered API tokens.
- 🔌 **One endpoint, many backends** — 5 built-in CLIs (Claude, Codex, Copilot, Antigravity, Grok) **+** any OpenAI-compatible HTTP server (vLLM, Ollama, MLX, LM Studio) **+** custom plugins.
- 🧭 **Smart routing** — alias-based model mapping with priority fallback chains, per-model provider overrides, and session reuse (`codex exec resume`).
- ⚙️ **Multiple execution modes** — `cli`, Claude **Agent SDK**, Codex **app-server**, and the new **channel-worker** bridge mode.
- 📡 **Real SSE streaming** — native NDJSON/JSONL event pipes, not fake post-hoc chunking.
- 📊 **Full dashboard** — live monitoring, Playground, request tracing with raw payloads, model/key management, rate limits, EN/KO + dark mode.
- 🔒 **Hardened** — Zod-validated config (fail-fast at startup), SHA-256 key auth, prompt/CLI injection guards, timing-safe comparisons, secret redaction.
- 🟣 **Anthropic Messages API** — `/v1/messages` lets native Claude Code / Anthropic SDK clients connect too.

## Quick Start

### ⭐ Easiest: let an AI CLI set it up

This repo is structured so an agentic CLI can install and configure it for you. Open **Claude Code** or **Codex** in an empty folder and ask:

> "Clone `https://github.com/starhunt/star-cliproxy`, read its README, then install dependencies, build, create `config.yaml` and `.env` (generate a strong `ADMIN_TOKEN` and an `sk-proxy-` prefixed `PROXY_API_KEY`), enable the providers I have installed, and start the backend and dashboard."

The agent runs the steps below and reports the URLs back to you.

### Manual

```bash
git clone https://github.com/starhunt/star-cliproxy.git
cd star-cliproxy
npm install && npm run build

cp config.example.yaml config.yaml
cp .env.example .env
# .env: ADMIN_TOKEN + PROXY_API_KEY (must start with sk-proxy-)
node -e "console.log('ADMIN_TOKEN='+require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('PROXY_API_KEY=sk-proxy-'+require('crypto').randomBytes(24).toString('hex'))"

npm run dev            # backend API → http://localhost:8300
npm run dev:dashboard  # dashboard   → http://localhost:5300
```

**Prerequisites:** Node.js 20+ and at least one authenticated CLI. Run each CLI once on its own first to finish login.

## Supported Providers

| Provider | Subscription | Install |
|---|---|---|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Claude Pro / Max | `npm i -g @anthropic-ai/claude-code` |
| [Codex](https://github.com/openai/codex) | ChatGPT Plus / Pro | `npm i -g @openai/codex` |
| [Copilot CLI](https://docs.github.com/en/copilot) | GitHub Copilot | `gh extension install github/gh-copilot` |
| ~~Gemini CLI~~ *(discontinued)* | — | use **Antigravity CLI** below — Gemini CLI was discontinued by Google |
| [Antigravity CLI](https://antigravity.google/) | Google AI Pro / Ultra | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |
| [Grok Build CLI](https://x.ai/cli) | SuperGrok / X Premium+ | `curl -fsSL https://x.ai/cli/install.sh \| bash` |
| **HTTP** | any OpenAI-compatible server | add from the dashboard (vLLM, Ollama, MLX, LM Studio…) |
| **Plugin** | custom CLI | [Plugin Guide](./plugins/README.md) |

## Usage

OpenAI SDKs (Python/TS), curl, and native Claude Code all work — just set the base URL and an `sk-proxy-` key.

```bash
# OpenAI-compatible (streaming)
curl http://localhost:8300/v1/chat/completions \
  -H "Authorization: Bearer sk-proxy-..." -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

```bash
# Native Claude Code → cliproxy (Anthropic Messages API)
ANTHROPIC_BASE_URL=http://localhost:8300 ANTHROPIC_API_KEY=sk-proxy-... claude
```

Models are exposed as **aliases** (e.g. `claude-sonnet`, `gpt-5`) mapping to a provider + real model. Manage mappings, providers, and keys from the dashboard or the Admin API.

## Execution Modes

| Mode | Provider | What it does |
|---|---|---|
| `cli` *(default)* | all | runs the CLI in print mode |
| `sdk` | Claude | Claude Agent SDK — session reuse, tool control, budget caps |
| `app-server` | Codex | persistent JSON-RPC process |
| `channel-worker` | Claude | runs an **interactive** Claude Code session via a managed bridge (no `claude -p`), capturing results through an MCP tool — avoids the 2026‑06‑15 `claude -p`/Agent SDK billing split. Start/stop from the dashboard. |

## Dashboard (`:5300`)

Live request monitoring & trends, **Playground**, model-mapping editor, provider config (execution mode + bridge controls), API keys, rate limits, and debug payload capture (CLI args + raw stdout, copy-as-curl). EN/KO, dark/light.

## Configuration

- `config.yaml` — providers, model mappings, rate limits, validation (Zod-validated at startup). See [`config.example.yaml`](./config.example.yaml).
- `.env` — `ADMIN_TOKEN`, `PROXY_API_KEY`.
- Custom providers auto-load from `plugins/`.

## Documentation

[Plugin Guide](./plugins/README.md) · [Provider Architecture](./docs/provider-architecture.md) · [Session Reuse](./docs/client-integration-session-reuse.md) · [Image Generation](./docs/codex-image-generation.md)

## Security

SHA-256 API-key auth · prompt-injection & CLI-injection prevention · timing-safe comparisons · Zod config validation · debug-log redaction with retention. **Never commit `.env`.**

## License

MIT. Subscriptions and CLI usage remain subject to each provider's terms of service.

Built with Claude Code.
