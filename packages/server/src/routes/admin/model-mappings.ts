import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { isReasoningEffort, type ProviderOverrides, type ReasoningEffort } from '@star-cliproxy/shared';
import { getDatabase } from '../../db/client.js';
import { modelMappings } from '../../db/schema.js';

interface CreateMappingBody {
  alias: string;
  provider: string;
  actual_model: string;
  display_name?: string;
  reasoning_effort?: string | null;
  provider_overrides?: ProviderOverrides | null;
  include_reasoning?: boolean | null;
  extra_body?: Record<string, unknown> | null;
  priority?: number;
  enabled?: boolean;
}

interface UpdateMappingBody {
  alias?: string;
  provider?: string;
  actual_model?: string;
  display_name?: string;
  reasoning_effort?: string | null;
  provider_overrides?: ProviderOverrides | null;
  include_reasoning?: boolean | null;
  extra_body?: Record<string, unknown> | null;
  priority?: number;
  enabled?: boolean;
}

// cliproxy가 직접 관리하는 표준 필드 — extra_body로 덮어쓰지 못하도록 거부.
const RESERVED_EXTRA_BODY_KEYS = new Set([
  'model', 'messages', 'stream', 'max_tokens', 'temperature',
]);
const MAX_EXTRA_BODY_BYTES = 4096;  // JSON 직렬화 후 크기 제한 (DB row bloat 방지)

function parseExtraBodyInput(value: unknown): { ok: true; value: Record<string, unknown> | null | undefined } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'extra_body must be an object or null.' };
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (RESERVED_EXTRA_BODY_KEYS.has(key)) {
      return { ok: false, reason: `extra_body cannot override reserved field "${key}".` };
    }
  }
  const serialized = JSON.stringify(obj);
  if (serialized.length > MAX_EXTRA_BODY_BYTES) {
    return { ok: false, reason: `extra_body too large (max ${MAX_EXTRA_BODY_BYTES} bytes).` };
  }
  return { ok: true, value: Object.keys(obj).length > 0 ? obj : null };
}

// boolean | null | undefined 입력 검증. NULL/undefined = 상속(전역 default).
function parseIncludeReasoningInput(value: unknown): { ok: true; value: boolean | null | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'boolean') return { ok: false };
  return { ok: true, value };
}

// provider_overrides 입력 검증.
// null → 명시적 unset, 화이트리스트 외 키 → silently drop, 잘못된 타입 → 400 트리거.
// 깊이 제한: 최대 2단계 (cli_options 1단계 + 그 안의 필드).
function parseProviderOverridesInput(value: unknown): { ok: true; value: ProviderOverrides | null | undefined } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'provider_overrides must be an object or null.' };
  }
  const raw = value as Record<string, unknown>;
  const out: ProviderOverrides = {};
  if (raw.mode !== undefined) {
    if (typeof raw.mode !== 'string' || !['cli', 'sdk', 'app-server', 'channel-worker'].includes(raw.mode)) {
      return { ok: false, reason: 'provider_overrides.mode must be one of: cli, sdk, app-server, channel-worker.' };
    }
    out.mode = raw.mode as ProviderOverrides['mode'];
  }
  if (raw.extra_args !== undefined) {
    if (!Array.isArray(raw.extra_args) || !raw.extra_args.every((a) => typeof a === 'string')) {
      return { ok: false, reason: 'provider_overrides.extra_args must be string[].' };
    }
    out.extra_args = raw.extra_args as string[];
  }
  if (raw.timeout_ms !== undefined) {
    if (typeof raw.timeout_ms !== 'number' || raw.timeout_ms <= 0) {
      return { ok: false, reason: 'provider_overrides.timeout_ms must be a positive number.' };
    }
    out.timeout_ms = raw.timeout_ms;
  }
  if (raw.working_dir !== undefined) {
    if (typeof raw.working_dir !== 'string' || raw.working_dir.trim() === '') {
      return { ok: false, reason: 'provider_overrides.working_dir must be a non-empty string.' };
    }
    out.working_dir = raw.working_dir;
  }
  if (raw.cli_options !== undefined) {
    if (typeof raw.cli_options !== 'object' || raw.cli_options === null || Array.isArray(raw.cli_options)) {
      return { ok: false, reason: 'provider_overrides.cli_options must be an object.' };
    }
    const rawCli = raw.cli_options as Record<string, unknown>;
    const cli: NonNullable<ProviderOverrides['cli_options']> = {};
    if (rawCli.ephemeral !== undefined) {
      if (typeof rawCli.ephemeral !== 'boolean') return { ok: false, reason: 'cli_options.ephemeral must be boolean.' };
      cli.ephemeral = rawCli.ephemeral;
    }
    if (rawCli.enable_session_reuse !== undefined) {
      if (typeof rawCli.enable_session_reuse !== 'boolean') return { ok: false, reason: 'cli_options.enable_session_reuse must be boolean.' };
      cli.enable_session_reuse = rawCli.enable_session_reuse;
    }
    if (rawCli.session_ttl_ms !== undefined) {
      if (typeof rawCli.session_ttl_ms !== 'number' || rawCli.session_ttl_ms <= 0) {
        return { ok: false, reason: 'cli_options.session_ttl_ms must be a positive number.' };
      }
      cli.session_ttl_ms = rawCli.session_ttl_ms;
    }
    if (Object.keys(cli).length > 0) out.cli_options = cli;
  }
  if (raw.sdk_options !== undefined) {
    if (typeof raw.sdk_options !== 'object' || raw.sdk_options === null || Array.isArray(raw.sdk_options)) {
      return { ok: false, reason: 'provider_overrides.sdk_options must be an object.' };
    }
    const rawSdk = raw.sdk_options as Record<string, unknown>;
    const sdk: NonNullable<ProviderOverrides['sdk_options']> = {};
    if (rawSdk.max_turns !== undefined) {
      if (typeof rawSdk.max_turns !== 'number' || rawSdk.max_turns <= 0) return { ok: false, reason: 'sdk_options.max_turns must be a positive number.' };
      sdk.max_turns = rawSdk.max_turns;
    }
    if (rawSdk.permission_mode !== undefined) {
      if (typeof rawSdk.permission_mode !== 'string') return { ok: false, reason: 'sdk_options.permission_mode must be string.' };
      sdk.permission_mode = rawSdk.permission_mode;
    }
    if (rawSdk.allowed_tools !== undefined) {
      if (!Array.isArray(rawSdk.allowed_tools) || !rawSdk.allowed_tools.every((a) => typeof a === 'string')) return { ok: false, reason: 'sdk_options.allowed_tools must be string[].' };
      sdk.allowed_tools = rawSdk.allowed_tools as string[];
    }
    if (rawSdk.disallowed_tools !== undefined) {
      if (!Array.isArray(rawSdk.disallowed_tools) || !rawSdk.disallowed_tools.every((a) => typeof a === 'string')) return { ok: false, reason: 'sdk_options.disallowed_tools must be string[].' };
      sdk.disallowed_tools = rawSdk.disallowed_tools as string[];
    }
    if (rawSdk.max_budget_usd !== undefined) {
      if (typeof rawSdk.max_budget_usd !== 'number' || rawSdk.max_budget_usd <= 0) return { ok: false, reason: 'sdk_options.max_budget_usd must be a positive number.' };
      sdk.max_budget_usd = rawSdk.max_budget_usd;
    }
    if (rawSdk.session_ttl_ms !== undefined) {
      if (typeof rawSdk.session_ttl_ms !== 'number' || rawSdk.session_ttl_ms <= 0) return { ok: false, reason: 'sdk_options.session_ttl_ms must be a positive number.' };
      sdk.session_ttl_ms = rawSdk.session_ttl_ms;
    }
    if (rawSdk.enable_session_reuse !== undefined) {
      if (typeof rawSdk.enable_session_reuse !== 'boolean') return { ok: false, reason: 'sdk_options.enable_session_reuse must be boolean.' };
      sdk.enable_session_reuse = rawSdk.enable_session_reuse;
    }
    if (rawSdk.persist_session !== undefined) {
      if (typeof rawSdk.persist_session !== 'boolean') return { ok: false, reason: 'sdk_options.persist_session must be boolean.' };
      sdk.persist_session = rawSdk.persist_session;
    }
    if (Object.keys(sdk).length > 0) out.sdk_options = sdk;
  }
  if (raw.channel_options !== undefined) {
    if (typeof raw.channel_options !== 'object' || raw.channel_options === null || Array.isArray(raw.channel_options)) {
      return { ok: false, reason: 'provider_overrides.channel_options must be an object.' };
    }
    const rawChannel = raw.channel_options as Record<string, unknown>;
    const channel: NonNullable<ProviderOverrides['channel_options']> = {};
    if (rawChannel.endpoint_url !== undefined) {
      if (typeof rawChannel.endpoint_url !== 'string' || rawChannel.endpoint_url.trim() === '') return { ok: false, reason: 'channel_options.endpoint_url must be a non-empty string.' };
      channel.endpoint_url = rawChannel.endpoint_url;
    }
    if (rawChannel.api_key !== undefined) {
      if (typeof rawChannel.api_key !== 'string' || rawChannel.api_key.trim() === '') return { ok: false, reason: 'channel_options.api_key must be a non-empty string.' };
      channel.api_key = rawChannel.api_key;
    }
    if (rawChannel.poll_interval_ms !== undefined) {
      if (typeof rawChannel.poll_interval_ms !== 'number' || rawChannel.poll_interval_ms <= 0) return { ok: false, reason: 'channel_options.poll_interval_ms must be a positive number.' };
      channel.poll_interval_ms = rawChannel.poll_interval_ms;
    }
    if (rawChannel.result_timeout_ms !== undefined) {
      if (typeof rawChannel.result_timeout_ms !== 'number' || rawChannel.result_timeout_ms <= 0) return { ok: false, reason: 'channel_options.result_timeout_ms must be a positive number.' };
      channel.result_timeout_ms = rawChannel.result_timeout_ms;
    }
    if (rawChannel.response_schema !== undefined) {
      if (typeof rawChannel.response_schema !== 'object' || rawChannel.response_schema === null || Array.isArray(rawChannel.response_schema)) {
        return { ok: false, reason: 'channel_options.response_schema must be an object.' };
      }
      channel.response_schema = rawChannel.response_schema as Record<string, unknown>;
    }
    if (rawChannel.isolation !== undefined) {
      if (typeof rawChannel.isolation !== 'string' || !['external', 'one-job-per-worker', 'shared-session'].includes(rawChannel.isolation)) {
        return { ok: false, reason: 'channel_options.isolation must be one of: external, one-job-per-worker, shared-session.' };
      }
      channel.isolation = rawChannel.isolation as NonNullable<ProviderOverrides['channel_options']>['isolation'];
    }
    if (Object.keys(channel).length > 0) out.channel_options = channel;
  }
  return { ok: true, value: Object.keys(out).length > 0 ? out : null };
}

// DB row에서 providerOverrides + extraBody (JSON string) → 객체 변환
function rowWithParsedOverrides(row: Record<string, unknown>): Record<string, unknown> {
  const parsed: Record<string, unknown> = { ...row };
  // providerOverrides
  const rawOverrides = row.providerOverrides;
  if (typeof rawOverrides === 'string' && rawOverrides.length > 0) {
    try { parsed.providerOverrides = JSON.parse(rawOverrides); } catch { parsed.providerOverrides = null; }
  } else {
    parsed.providerOverrides = null;
  }
  // extraBody
  const rawExtra = row.extraBody;
  if (typeof rawExtra === 'string' && rawExtra.length > 0) {
    try { parsed.extraBody = JSON.parse(rawExtra); } catch { parsed.extraBody = null; }
  } else {
    parsed.extraBody = null;
  }
  return parsed;
}

// 사용자 입력 reasoning_effort 정규화/검증.
// null → 명시적 unset, 화이트리스트 외 값 → 400 트리거(undefined 반환 + flag).
function parseReasoningEffortInput(value: unknown): { ok: true; value: ReasoningEffort | null | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  const normalized = value.trim().toLowerCase();
  if (!normalized) return { ok: true, value: null };
  if (!isReasoningEffort(normalized)) return { ok: false };
  return { ok: true, value: normalized };
}

export function registerModelMappingsRoutes(app: FastifyInstance): void {
  // 목록
  app.get('/admin/model-mappings', async (_request, reply) => {
    const db = getDatabase();
    const all = await db.select().from(modelMappings);
    return reply.send(all.map(rowWithParsedOverrides));
  });

  // 생성
  app.post<{ Body: CreateMappingBody }>('/admin/model-mappings', async (request, reply) => {
    const { alias, provider, actual_model, display_name, reasoning_effort, provider_overrides, include_reasoning, extra_body, priority, enabled } = request.body;

    if (!alias || !provider || !actual_model) {
      return reply.status(400).send({ error: { message: 'alias, provider, actual_model are required.' } });
    }

    const parsedEffort = parseReasoningEffortInput(reasoning_effort);
    if (!parsedEffort.ok) {
      return reply.status(400).send({
        error: { message: 'reasoning_effort must be one of: low, medium, high, xhigh, max.' },
      });
    }

    const parsedOverrides = parseProviderOverridesInput(provider_overrides);
    if (!parsedOverrides.ok) {
      return reply.status(400).send({ error: { message: parsedOverrides.reason } });
    }

    const parsedInclude = parseIncludeReasoningInput(include_reasoning);
    if (!parsedInclude.ok) {
      return reply.status(400).send({ error: { message: 'include_reasoning must be boolean or null.' } });
    }

    const parsedExtra = parseExtraBodyInput(extra_body);
    if (!parsedExtra.ok) {
      return reply.status(400).send({ error: { message: parsedExtra.reason } });
    }

    const db = getDatabase();
    const id = nanoid();
    const now = new Date().toISOString();

    await db.insert(modelMappings).values({
      id,
      alias,
      provider,
      actualModel: actual_model,
      displayName: display_name,
      reasoningEffort: parsedEffort.value ?? null,
      providerOverrides: parsedOverrides.value ? JSON.stringify(parsedOverrides.value) : null,
      includeReasoning: parsedInclude.value ?? null,
      extraBody: parsedExtra.value ? JSON.stringify(parsedExtra.value) : null,
      priority: priority ?? 0,
      enabled: enabled ?? true,
      createdAt: now,
      updatedAt: now,
    });

    const created = await db.select().from(modelMappings).where(eq(modelMappings.id, id)).limit(1);
    return reply.status(201).send(rowWithParsedOverrides(created[0]));
  });

  // 수정
  app.put<{ Params: { id: string }; Body: UpdateMappingBody }>('/admin/model-mappings/:id', async (request, reply) => {
    const { id } = request.params;
    const body = request.body;
    const db = getDatabase();

    const existing = await db.select().from(modelMappings).where(eq(modelMappings.id, id)).limit(1);
    if (existing.length === 0) {
      return reply.status(404).send({ error: { message: 'Mapping not found.' } });
    }

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.alias !== undefined) updates.alias = body.alias;
    if (body.provider !== undefined) updates.provider = body.provider;
    if (body.actual_model !== undefined) updates.actualModel = body.actual_model;
    if (body.display_name !== undefined) updates.displayName = body.display_name;
    if (body.priority !== undefined) updates.priority = body.priority;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.reasoning_effort !== undefined) {
      const parsed = parseReasoningEffortInput(body.reasoning_effort);
      if (!parsed.ok) {
        return reply.status(400).send({
          error: { message: 'reasoning_effort must be one of: low, medium, high, xhigh, max.' },
        });
      }
      updates.reasoningEffort = parsed.value;
    }
    if (body.provider_overrides !== undefined) {
      const parsed = parseProviderOverridesInput(body.provider_overrides);
      if (!parsed.ok) {
        return reply.status(400).send({ error: { message: parsed.reason } });
      }
      updates.providerOverrides = parsed.value ? JSON.stringify(parsed.value) : null;
    }
    if (body.include_reasoning !== undefined) {
      const parsed = parseIncludeReasoningInput(body.include_reasoning);
      if (!parsed.ok) {
        return reply.status(400).send({ error: { message: 'include_reasoning must be boolean or null.' } });
      }
      updates.includeReasoning = parsed.value;
    }
    if (body.extra_body !== undefined) {
      const parsed = parseExtraBodyInput(body.extra_body);
      if (!parsed.ok) {
        return reply.status(400).send({ error: { message: parsed.reason } });
      }
      updates.extraBody = parsed.value ? JSON.stringify(parsed.value) : null;
    }

    await db.update(modelMappings).set(updates).where(eq(modelMappings.id, id));

    const updated = await db.select().from(modelMappings).where(eq(modelMappings.id, id)).limit(1);
    return reply.send(rowWithParsedOverrides(updated[0]));
  });

  // 삭제
  app.delete<{ Params: { id: string } }>('/admin/model-mappings/:id', async (request, reply) => {
    const { id } = request.params;
    const db = getDatabase();

    const existing = await db.select().from(modelMappings).where(eq(modelMappings.id, id)).limit(1);
    if (existing.length === 0) {
      return reply.status(404).send({ error: { message: 'Mapping not found.' } });
    }

    await db.delete(modelMappings).where(eq(modelMappings.id, id));
    return reply.status(204).send();
  });
}
