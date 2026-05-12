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
  priority?: number;
  enabled?: boolean;
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
  return { ok: true, value: Object.keys(out).length > 0 ? out : null };
}

// DB row에서 providerOverrides(JSON string) → 객체 변환 + 반환용 가공
function rowWithParsedOverrides(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.providerOverrides;
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      return { ...row, providerOverrides: JSON.parse(raw) };
    } catch {
      return { ...row, providerOverrides: null };
    }
  }
  return { ...row, providerOverrides: null };
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
    const { alias, provider, actual_model, display_name, reasoning_effort, provider_overrides, priority, enabled } = request.body;

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
