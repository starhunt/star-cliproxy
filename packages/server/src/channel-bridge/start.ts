import { ChannelBridge, type BridgeServerOptions } from './bridge-server.js';

// 내장 Channel bridge standalone 진입점.
// ChannelBridgeManager가 별도 프로세스로 spawn한다.
// 시크릿(api_key)을 argv에 노출하지 않도록 옵션은 환경변수로 전달받는다.

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseExtraArgs(): string[] {
  const raw = process.env.BRIDGE_EXTRA_ARGS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

const options: BridgeServerOptions = {
  port: envInt('BRIDGE_PORT') ?? 8788,
  host: process.env.BRIDGE_HOST || '127.0.0.1',
  apiKey: process.env.BRIDGE_API_KEY || undefined,
  cliPath: process.env.BRIDGE_CLI_PATH || 'claude',
  defaultModel: process.env.BRIDGE_DEFAULT_MODEL || 'claude-sonnet-4-6',
  workingDir: process.env.BRIDGE_WORKING_DIR || undefined,
  timeoutMs: envInt('BRIDGE_TIMEOUT_MS') ?? 300_000,
  extraArgs: parseExtraArgs(),
  maxConcurrent: envInt('BRIDGE_MAX_CONCURRENT') ?? 4,
  maxQueue: envInt('BRIDGE_MAX_QUEUE') ?? 256,
};

const bridge = new ChannelBridge(options);

bridge.listen()
  .then(() => {
    // manager는 이 라인을 stdout에서 감지하거나 /health polling으로 ready를 판단한다.
    console.log(`[channel-bridge] listening on http://${options.host}:${options.port} (model=${options.defaultModel})`);
    process.send?.({ type: 'ready', port: options.port });
  })
  .catch((err: unknown) => {
    console.error(`[channel-bridge] failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

async function shutdown(signal: string): Promise<void> {
  console.log(`[channel-bridge] received ${signal}, shutting down`);
  await bridge.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
