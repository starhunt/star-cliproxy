import type { FastifyInstance } from 'fastify';
import type { DebugService } from '../../services/debug.js';

interface UpdateDebugBody {
  global?: boolean;
  model?: string;
  enabled?: boolean;
}

export function registerDebugRoutes(app: FastifyInstance, debug: DebugService): void {
  // 디버그 설정 조회
  app.get('/admin/debug', async (_request, reply) => {
    return reply.send(debug.getConfig());
  });

  // 디버그 설정 변경
  app.put<{ Body: UpdateDebugBody }>('/admin/debug', async (request, reply) => {
    const { global, model, enabled } = request.body;

    if (global !== undefined) {
      debug.setGlobal(global);
    }

    if (model !== undefined && enabled !== undefined) {
      debug.setModel(model, enabled);
    }

    return reply.send(debug.getConfig());
  });

  // 디버그 로그 조회
  app.get<{ Querystring: { limit?: string; offset?: string; model?: string; search?: string; searchScope?: string } }>(
    '/admin/debug-logs',
    async (request, reply) => {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 50;
      const offset = request.query.offset ? parseInt(request.query.offset, 10) : 0;
      const model = request.query.model;
      const search = request.query.search;
      const searchScope = (['all', 'request', 'response'].includes(request.query.searchScope ?? '')
        ? request.query.searchScope as 'all' | 'request' | 'response'
        : 'all');

      const filterOpts = { model, search, searchScope };
      const [logs, total] = await Promise.all([
        debug.getLogs({ limit, offset, ...filterOpts }),
        debug.getLogCount(filterOpts),
      ]);
      return reply.send({ data: logs, pagination: { limit, offset, total } });
    },
  );

  // 디버그 로그 개별 삭제
  app.delete<{ Params: { id: string } }>('/admin/debug-logs/:id', async (request, reply) => {
    const deleted = await debug.deleteLog(request.params.id);
    if (!deleted) {
      return reply.status(404).send({ error: { message: 'Debug log not found.' } });
    }
    return reply.send({ success: true });
  });

  // 디버그 로그 복수 삭제
  app.post<{ Body: { ids: string[] } }>('/admin/debug-logs/batch-delete', async (request, reply) => {
    const { ids } = request.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.status(400).send({ error: { message: 'ids array is required.' } });
    }
    const deleted = await debug.deleteLogs(ids);
    return reply.send({ deleted });
  });

  // 디버그 로그 전체 삭제
  app.delete('/admin/debug-logs', async (_request, reply) => {
    const deleted = await debug.clearLogs();
    return reply.send({ deleted });
  });
}
