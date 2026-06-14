# Claude channel-worker execution mode

## Background

Anthropic's announced 2026-06-15 billing split moves `claude -p` and Claude Agent SDK usage to the separate Agent SDK credit bucket. star-cliproxy currently supports:

- `mode: "cli"` for Claude, which invokes `claude -p`.
- `mode: "sdk"` for Claude Agent SDK.

Both paths are useful but should not be the only Claude execution options after the split.

## Goal

Add an experimental Claude execution mode that can submit jobs to a running Claude Code Channel bridge instead of invoking `claude -p` or the Agent SDK directly.

## Initial Scope

- Add `mode: "channel-worker"` to provider config.
- Add `channel_options` with:
  - `endpoint_url`
  - `api_key`
  - `poll_interval_ms`
  - `result_timeout_ms`
  - `response_schema`
  - `isolation`
- Submit jobs to an external bridge using:
  - `POST /jobs`
  - `GET /jobs/:job_id` or returned `status_url`
- Return OpenAI/Anthropic-compatible text responses through the existing provider interface.
- Keep streaming as a compatibility wrapper around non-streaming completion in the first version.

## Out of Scope for First Patch

- Launching and supervising Claude Code PTY sessions inside star-cliproxy.
- Built-in MCP Channel server.
- Warm worker pool lifecycle.
- Guaranteed billing classification.

## Follow-up

- Add an internal `channel-pool` implementation with one-job-per-worker isolation.
- Add dashboard controls for `channel_options`.
- Add bridge health/status endpoint checks.
- Add end-to-end test against a real Claude Code Channel bridge.
