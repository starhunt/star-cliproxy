import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { isReasoningEffort, type ReasoningEffort } from '@star-cliproxy/shared';
import { getDatabase } from '../../db/client.js';
import { modelMappings } from '../../db/schema.js';

interface CreateMappingBody {
  alias: string;
  provider: string;
  actual_model: string;
  display_name?: string;
  reasoning_effort?: string | null;
  priority?: number;
  enabled?: boolean;
}

interface UpdateMappingBody {
  alias?: string;
  provider?: string;
  actual_model?: string;
  display_name?: string;
  reasoning_effort?: string | null;
  priority?: number;
  enabled?: boolean;
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
    return reply.send(all);
  });

  // 생성
  app.post<{ Body: CreateMappingBody }>('/admin/model-mappings', async (request, reply) => {
    const { alias, provider, actual_model, display_name, reasoning_effort, priority, enabled } = request.body;

    if (!alias || !provider || !actual_model) {
      return reply.status(400).send({ error: { message: 'alias, provider, actual_model are required.' } });
    }

    const parsedEffort = parseReasoningEffortInput(reasoning_effort);
    if (!parsedEffort.ok) {
      return reply.status(400).send({
        error: { message: 'reasoning_effort must be one of: low, medium, high, xhigh, max.' },
      });
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
      priority: priority ?? 0,
      enabled: enabled ?? true,
      createdAt: now,
      updatedAt: now,
    });

    const created = await db.select().from(modelMappings).where(eq(modelMappings.id, id)).limit(1);
    return reply.status(201).send(created[0]);
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

    await db.update(modelMappings).set(updates).where(eq(modelMappings.id, id));

    const updated = await db.select().from(modelMappings).where(eq(modelMappings.id, id)).limit(1);
    return reply.send(updated[0]);
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
