// PoC MCP 서버 (stdio): interactive claude 세션이 호출하는 report_result tool 제공.
// 호출되면 결과를 POC_RESULT_FILE에 기록한다 → 드라이버가 그 파일로 완료를 감지.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { writeFileSync } from 'node:fs';

const RESULT_FILE = process.env.POC_RESULT_FILE;

const server = new McpServer({ name: 'channel-reporter', version: '0.0.1' });

server.registerTool(
  'report_result',
  {
    description: 'Report the final answer back to the channel bridge. Call this exactly once when the task is complete.',
    inputSchema: {
      payload: z.string().describe('the final answer / result text'),
      status: z.enum(['success', 'error']).optional(),
    },
  },
  async ({ payload, status }) => {
    if (RESULT_FILE) {
      writeFileSync(RESULT_FILE, JSON.stringify({ payload, status: status ?? 'success', at: Date.now() }));
    }
    return { content: [{ type: 'text', text: 'result reported to bridge' }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
