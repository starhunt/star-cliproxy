import { like } from 'drizzle-orm';
import type { HttpProviderConfig } from '@star-cliproxy/shared';
import { getDatabase } from '../db/client.js';
import { settings } from '../db/schema.js';
import type { ProviderRegistry } from './provider-registry.js';
import type { QueueManager } from '../services/queue.js';
import { HttpProvider } from './http-provider.js';

// DB 키 접두사
export const HTTP_PROVIDER_PREFIX = 'http_provider:';

interface LoaderLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

interface LoadResult {
  loaded: string[];
  failed: Array<{ name: string; error: string }>;
}

// 서버 시작 시 DB에서 등록된 HTTP 프로바이더를 로드하여 레지스트리에 등록
export async function loadHttpProviders(
  registry: ProviderRegistry,
  queueManager: QueueManager,
  logger?: LoaderLogger,
): Promise<LoadResult> {
  const result: LoadResult = { loaded: [], failed: [] };

  let rows: Array<{ key: string; value: string }>;
  try {
    const db = getDatabase();
    rows = await db
      .select()
      .from(settings)
      .where(like(settings.key, `${HTTP_PROVIDER_PREFIX}%`));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn(`[http-provider-loader] DB 조회 실패: ${message}`);
    return result;
  }

  for (const row of rows) {
    const name = row.key.replace(HTTP_PROVIDER_PREFIX, '');

    let config: HttpProviderConfig;
    try {
      config = JSON.parse(row.value) as HttpProviderConfig;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.warn(`[http-provider-loader] "${name}" 설정 파싱 실패: ${message}`);
      result.failed.push({ name, error: `Config parse error: ${message}` });
      continue;
    }

    if (config.enabled === false) {
      logger?.info(`[http-provider-loader] "${name}" 비활성화됨, 건너뜀`);
      continue;
    }

    if (registry.has(name)) {
      logger?.warn(`[http-provider-loader] "${name}" 이미 등록됨, 건너뜀`);
      continue;
    }

    try {
      const provider = new HttpProvider(name, config);
      registry.register(provider);
      queueManager.addQueue(name, config.max_concurrent);

      logger?.info(`[http-provider-loader] "${name}" 로드 완료 (base_url: ${config.base_url})`);
      result.loaded.push(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.warn(`[http-provider-loader] "${name}" 등록 실패: ${message}`);
      result.failed.push({ name, error: message });
    }
  }

  if (result.loaded.length > 0) {
    logger?.info(
      `[http-provider-loader] 총 ${result.loaded.length}개 HTTP 프로바이더 로드 완료: ${result.loaded.join(', ')}`,
    );
  }

  if (result.failed.length > 0) {
    logger?.warn(
      `[http-provider-loader] ${result.failed.length}개 실패: ${result.failed.map((f) => f.name).join(', ')}`,
    );
  }

  return result;
}
