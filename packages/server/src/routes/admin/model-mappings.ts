import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDatabase } from '../../db/client.js';
import { modelMappings } from '../../db/schema.js';

interface CreateMappingBody {
  alias: string;
  provider: string;
  actual_model: string;
  display_name?: string;
  priority?: number;
  enabled?: boolean;
}

interface UpdateMappingBody {
  alias?: string;
  provider?: string;
  actual_model?: string;
  display_name?: string;
  priority?: number;
  enabled?: boolean;
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
    const { alias, provider, actual_model, display_name, priority, enabled } = request.body;

    if (!alias || !provider || !actual_model) {
      return reply.status(400).send({ error: { message: 'alias, provider, actual_model are required.' } });
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
