import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AppConfig } from '@star-cliproxy/shared';
import { getDatabase } from './client.js';
import { apiKeys, modelMappings } from './schema.js';
import { hashApiKey, getKeyPrefix } from '../middleware/auth.js';

export async function seedDatabase(config: AppConfig): Promise<void> {
  const db = getDatabase();

  // 초기 API 키 시드
  for (const keyConfig of config.auth.initialKeys) {
    if (!keyConfig.key) continue;

    const keyHash = hashApiKey(keyConfig.key);
    const existing = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(apiKeys).values({
        id: nanoid(),
        keyHash,
        keyPrefix: getKeyPrefix(keyConfig.key),
        name: keyConfig.name,
        enabled: true,
        createdAt: new Date().toISOString(),
      });
    }
  }

  // 초기 모델 매핑 시드 (기존 매핑이 없을 때만)
  const existingMappings = await db.select().from(modelMappings).limit(1);
  if (existingMappings.length === 0) {
    for (const mapping of config.modelMappings) {
      await db.insert(modelMappings).values({
        id: nanoid(),
        alias: mapping.alias,
        provider: mapping.provider,
        actualModel: mapping.actual_model,
        displayName: mapping.alias,
        priority: 0,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  }
}
