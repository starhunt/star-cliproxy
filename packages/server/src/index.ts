import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { loadConfig } from './config/loader.js';
import { createApp } from './app.js';
import { closeDatabase } from './db/client.js';

// 프로젝트 루트 디렉토리 계산 (packages/server/src/index.ts → 3단계 상위)
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

// 루트의 .env 로드
dotenvConfig({ path: resolve(PROJECT_ROOT, '.env') });

async function main() {
  const configPath = process.env.CONFIG_PATH ?? resolve(PROJECT_ROOT, 'config.yaml');
  const config = loadConfig(configPath);

  const app = await createApp(config, dirname(configPath));

  try {
    await app.listen({
      port: config.server.port,
      host: config.server.host,
    });

    console.log(`
╔══════════════════════════════════════════════╗
║         star-cliproxy Server Started         ║
╠══════════════════════════════════════════════╣
║  API:        http://${config.server.host}:${config.server.port}       ║
║  Health:     http://${config.server.host}:${config.server.port}/health║
║  Admin API:  http://${config.server.host}:${config.server.port}/admin ║
╚══════════════════════════════════════════════╝
    `);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // 우아한 종료
  const shutdown = async () => {
    console.log('\nShutting down...');
    await app.close();
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
