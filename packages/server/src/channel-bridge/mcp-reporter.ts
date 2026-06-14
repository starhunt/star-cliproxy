import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createConnection } from 'node:net';

// claude interactive 세션에 --mcp-config로 attach되는 stdio MCP 서버.
// 모델이 report_result tool을 호출하면 결과를 unix socket으로 bridge(PTY 실행기)에 전달한다.
// 덕분에 bridge는 TUI 출력을 파싱하지 않고 구조화된 결과만 받는다.
// (zod v3/v4 타입 충돌을 피하려고 고수준 McpServer 대신 저수준 Server + raw JSON Schema를 사용)

const SOCKET_PATH = process.env.BRIDGE_REPORT_SOCKET;

function sendToBridge(message: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    if (!SOCKET_PATH) {
      resolve();
      return;
    }
    const client = createConnection(SOCKET_PATH, () => {
      client.write(`${JSON.stringify(message)}\n`, () => {
        client.end();
        resolve();
      });
    });
    // 전달 실패해도 tool 자체는 성공 응답 (모델이 멈추지 않도록)
    client.on('error', () => resolve());
  });
}

const server = new Server(
  { name: 'channel-reporter', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'report_result',
      description:
        'Report the final answer back to the channel bridge. Call this exactly once when the task is complete. The payload you pass is what gets returned to the API caller.',
      inputSchema: {
        type: 'object',
        properties: {
          payload: { type: 'string', description: 'the final answer / result text to return to the caller' },
          status: { type: 'string', enum: ['success', 'error'] },
        },
        required: ['payload'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'report_result') {
    return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true };
  }
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const payload = typeof args.payload === 'string' ? args.payload : String(args.payload ?? '');
  const status = args.status === 'error' ? 'error' : 'success';
  await sendToBridge({ type: 'report_result', payload, status });
  return { content: [{ type: 'text', text: 'result delivered to channel bridge' }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
