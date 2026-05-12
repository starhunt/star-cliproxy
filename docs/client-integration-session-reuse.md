# Client Integration Guide — Session Reuse with CLIProxy

**For developers building chat apps, agents, or any client that calls CLIProxy and needs conversation continuity.**

This guide covers how to integrate with CLIProxy's Codex CLI session reuse feature. Same target: keep the conversation alive across HTTP calls without re-sending the entire message history.

---

## 🚨 Read this first — client changes are mandatory

> **If the server-side mapping has `enable_session_reuse: true`, the client app MUST be updated.**
>
> CLIProxy keys threads by `X-Cliproxy-Session-Id` header (falling back to API key id). Without a unique header per user/room:
>
> - All requests sharing the same API key collapse into **one Codex thread**
> - Different users' messages **leak into each other's context**
> - Single-user dev works fine — the bug only surfaces in multi-user traffic
>
> This is a wire-contract change. Treat it as a coordinated server+client deployment, not a server-only toggle.

---

## TL;DR

1. **Create a mapping** with `cli_options.enable_session_reuse: true` (e.g. `gpt-5.5-chat`).
2. **Generate a unique session id per conversation** in your app (per `ChatRoom`, per `user_id × room_id`, etc.).
3. **Send it as the `X-Cliproxy-Session-Id` request header** on every call for that conversation.
4. **Optionally capture `X-Cliproxy-Thread-Id`** from the response (non-stream only) for debugging.
5. Persist `(user_id, room_id, cliproxy_session_id)` in your own DB.

CLIProxy will automatically route the second and subsequent calls to `codex exec resume <thread_id>`, so Codex keeps the context.

---

## 1. Server prerequisites (one-time, ops side)

Add a mapping that enables session reuse (or use the dashboard's **Provider Overrides** UI):

```yaml
# config.yaml
model_mappings:
  - alias: "gpt-5.5-chat"
    provider: "codex"
    actual_model: "gpt-5.5"
    provider_overrides:
      cli_options:
        enable_session_reuse: true
        session_ttl_ms: 1800000   # 30 min (default)
```

Or keep a single one-shot mapping (`gpt-5.5`) and add a chat variant — same provider, different defaults.

Verify with curl:

```bash
curl -s http://localhost:8300/admin/model-mappings \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.[] | select(.alias=="gpt-5.5-chat")'
```

---

## 2. Choosing your session id

CLIProxy resolves the session in this order:

1. `X-Cliproxy-Session-Id` request header — **validated** `^[A-Za-z0-9._:-]{1,128}$`, max 128 chars
2. API key id (fallback)
3. `"anonymous"`

### Recommended formats

```
user-<userId>-room-<roomId>            # single tenant, one mapping per room
org-<orgId>-user-<userId>-room-<roomId> # multi-tenant SaaS
sess-<uuid>                            # opaque, generated when room is created
```

### Anti-patterns (DO NOT)

- Reuse the same id across different conversations → contexts will merge
- Use raw user input as the id (allows session-hijacking via guessable values)
- Embed a plaintext API key or PII — the id may appear in server logs

### Security note

The header is not authentication. **A client that knows another user's session-id can join that conversation** (because Codex routes by `thread_id`, which CLIProxy keys by your session-id). Mitigations:

- Generate sufficiently random ids server-side (UUID v4, ULID, nanoid 20+ chars).
- Treat the id as a per-user secret — don't expose it in URLs the user pastes.
- For hard isolation, separate API keys per tenant.

---

## 3. Storage model (your app's DB)

```
chat_rooms
  id                          PK
  user_id                     FK
  cliproxy_session_id         text, UNIQUE per (user_id, project)
  title                       text
  cliproxy_thread_id          text, nullable      -- optional cache from response header
  created_at                  timestamp
  last_message_at             timestamp
```

You **do not** need to track every message inside Codex — CLIProxy/Codex handles context. But you **should** still persist messages in your own DB for:

- UI rendering (chat history)
- Search / RAG
- GDPR / audit / deletion
- Reconstructing a session if `cliproxy_session_id` ever rotates

---

## 4. Code examples

### Python (OpenAI SDK)

```python
from openai import OpenAI

# CLIProxy is OpenAI-compatible
client = OpenAI(
    base_url="http://localhost:8300/v1",
    api_key="sk-proxy-xxxx",
)

def send_in_room(room_session_id: str, message: str) -> str:
    """Send a message into a chat room. Context is kept across calls automatically."""
    response = client.chat.completions.create(
        model="gpt-5.5-chat",
        messages=[{"role": "user", "content": message}],
        # Optional: set max_tokens, temperature, etc.
        extra_headers={
            "X-Cliproxy-Session-Id": room_session_id,
        },
    )
    return response.choices[0].message.content

# Usage
room_id = "user-42-room-7"

reply1 = send_in_room(room_id, "My name is Foo. Just say hi.")
print(reply1)
# Hi Foo!

reply2 = send_in_room(room_id, "What's my name?")
print(reply2)
# Foo.
```

### Streaming with `extra_headers`

```python
stream = client.chat.completions.create(
    model="gpt-5.5-chat",
    messages=[{"role": "user", "content": "Continue the story."}],
    stream=True,
    extra_headers={"X-Cliproxy-Session-Id": "user-42-room-7"},
)

for chunk in stream:
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)
```

> **Note**: `X-Cliproxy-Thread-Id` is only exposed on non-stream responses (SSE headers must be flushed before the thread id is captured). For stream calls, the session id is sufficient — CLIProxy handles thread routing internally.

### TypeScript (OpenAI SDK)

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:8300/v1',
  apiKey: process.env.CLIPROXY_API_KEY!,
});

async function sendInRoom(sessionId: string, content: string) {
  const response = await client.chat.completions.create(
    {
      model: 'gpt-5.5-chat',
      messages: [{ role: 'user', content }],
    },
    {
      headers: { 'X-Cliproxy-Session-Id': sessionId },
    },
  );
  return response.choices[0].message.content;
}

// Multi-user, multi-room
await sendInRoom('user-A-room-python-help', 'How do I use asyncio?');
await sendInRoom('user-B-room-trip-plan', 'Plan a trip to Kyoto.');
await sendInRoom('user-A-room-python-help', 'Show me an example.');
// User A's second call sees only their Python context, not User B's trip context.
```

### TypeScript (raw fetch)

```ts
async function chat(sessionId: string, message: string): Promise<string> {
  const res = await fetch('http://localhost:8300/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.CLIPROXY_API_KEY}`,
      'X-Cliproxy-Session-Id': sessionId,
    },
    body: JSON.stringify({
      model: 'gpt-5.5-chat',
      messages: [{ role: 'user', content: message }],
    }),
  });
  const data = await res.json();
  return data.choices[0].message.content;
}
```

### curl (debugging)

```bash
# Inspect the X-Cliproxy-Thread-Id response header (non-stream only)
curl -i http://localhost:8300/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "X-Cliproxy-Session-Id: debug-test-1" \
  -d '{"model":"gpt-5.5-chat","messages":[{"role":"user","content":"hi"}]}' \
  | grep -i 'X-Cliproxy-Thread-Id'
```

---

## 5. Backend integration pattern (chat app)

A minimal Express handler that maps an authenticated user + room to a session id:

```ts
app.post('/api/rooms/:roomId/messages', requireAuth, async (req, res) => {
  const { roomId } = req.params;
  const { content } = req.body;
  const userId = req.user.id;

  // Look up (or create) the room mapping in your DB
  const room = await db.chatRooms.findFirst({
    where: { id: roomId, userId },
  });
  if (!room) return res.status(404).end();

  // 1. Send to CLIProxy with stable session id
  const reply = await client.chat.completions.create(
    {
      model: 'gpt-5.5-chat',
      messages: [{ role: 'user', content }],
    },
    { headers: { 'X-Cliproxy-Session-Id': room.cliproxySessionId } },
  );

  // 2. Persist messages in your DB (for UI / search / GDPR)
  await db.messages.createMany([
    { roomId, role: 'user', content },
    { roomId, role: 'assistant', content: reply.choices[0].message.content! },
  ]);

  res.json({ reply: reply.choices[0].message.content });
});
```

### Creating a room

```ts
import { nanoid } from 'nanoid';

app.post('/api/rooms', requireAuth, async (req, res) => {
  const room = await db.chatRooms.create({
    userId: req.user.id,
    title: req.body.title ?? 'New chat',
    // Generate a random session id once and persist it
    cliproxySessionId: `sess-${nanoid(24)}`,
  });
  res.json(room);
});
```

---

## 6. TTL and recovery

- Default session TTL is **30 minutes** (`session_ttl_ms`). Configurable per mapping.
- If a user is silent for >TTL and then sends a message, CLIProxy treats it as a **new thread** — the context is lost.
- Codex's jsonl is still on disk; you could in theory rebuild, but the prescribed pattern is: **let your DB hold the truth, treat Codex context as ephemeral cache**.

### Recovery options when context is lost

| Option | When to use |
|--------|-------------|
| Accept the loss (new thread, fresh context) | Casual chat, short sessions |
| Replay last N messages from your DB as priming | Important continuity |
| Bump `session_ttl_ms` to e.g. 4 hours | Always-on workflow tools |

---

## 7. Provider mode selection cheat sheet

| Need | Recommended config |
|------|--------------------|
| Stateless one-shot (current default) | Mapping without `provider_overrides` (e.g. `gpt-5.5`) |
| Session continuity per user / per room | Mapping with `enable_session_reuse: true` + `X-Cliproxy-Session-Id` header |
| Highest throughput, single user | `mode: "app-server"` (experimental) |

---

## 8. Common pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| Context resets every call | Header missing, or different value per call | Persist the session id; send it every time for that conversation |
| `thread/resume failed: no rollout found` | First call ran with `ephemeral: true` | Mapping must have `enable_session_reuse: true` (CLIProxy auto-forces `ephemeral: false`) |
| Two users see each other's context | Same session id for both | Make session ids unique per `(user × room)` |
| Image upload fails on second call | Resume mode + image attachment | Attach images on the first call only, or accept a new thread when images are sent |
| Sandbox flag not applied on second call | `-s` and similar flags are ignored by `exec resume` | Set sandbox in the first call (CLIProxy auto-filters them on resume) |

---

## 9. Checklist for an "AI agent" implementing the client

When you ask an LLM coding agent (Claude Code, Codex, etc.) to implement the chat app, give it this checklist:

```
[ ] Add a `cliproxy_session_id` column (text, unique per user×room) to the chat_rooms table.
[ ] When a room is created, generate `sess-<nanoid(24)>` and store it.
[ ] When sending a message, send the OpenAI request with header `X-Cliproxy-Session-Id: <room.cliproxy_session_id>`.
[ ] Use a model alias that has `enable_session_reuse: true` (e.g. `gpt-5.5-chat`).
[ ] Continue to persist every message in your own DB (do not rely on Codex jsonl for retrieval).
[ ] Do not retry with a *different* session id when a request fails — that creates a new thread.
[ ] Treat the 30-minute TTL as soft: on long gaps, your app may need to re-prime context from your DB.
[ ] Do not expose session ids in URLs that users can paste/share.
```

---

## 10. FAQ

**Q: Do I still need to send the full `messages` array?**
A: For Chat Completions you must always include at least the current user message. CLIProxy/Codex maintains the prior turns on their side, so you don't need to replay older messages — but the `messages` array must contain the *current* input.

**Q: Can I switch models mid-conversation?**
A: No — the session manager keys by `(clientKey, model)`. Switching model auto-invalidates the thread. Stick with one alias per conversation, or accept the reset.

**Q: How do I delete a user's data?**
A: Drop messages in your DB. CLIProxy's in-memory session manager will expire entries on its own (TTL). If you need hard server-side deletion now, remove the matching jsonl files under `~/.codex/sessions/...`.

**Q: Does this work with the Anthropic API endpoint (`/v1/messages`)?**
A: Yes — both `/v1/chat/completions` and `/v1/messages` honor `X-Cliproxy-Session-Id`.

**Q: How do I see what's active?**
A: Currently there's no admin endpoint for live sessions (planned). You can check `~/.codex/sessions/` directories for active jsonl rollouts.
