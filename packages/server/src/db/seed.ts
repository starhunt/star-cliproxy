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

  // 모델 매핑 시드 (additive): config.yaml의 alias 중 DB에 없는 것만 추가한다.
  // 기존 매핑은 절대 덮어쓰지 않는다 — DB가 런타임 SSOT이고 대시보드
  // (admin/model-mappings)에서 편집한 매핑을 매 재시작마다 클로버링하면 회귀이기 때문.
  // (이슈 #38: "매 재시작 강제 upsert" 제안을 검토 후 additive로 채택.)
  // [followup] config에서 제거/수정한 매핑은 자동 삭제·갱신되지 않는다(추가만). 정리는 대시보드에서.
  const existingMappings = await db
    .select({ alias: modelMappings.alias })
    .from(modelMappings);
  const existingAliases = new Set(existingMappings.map((m) => m.alias));

  for (const mapping of config.modelMappings) {
    if (existingAliases.has(mapping.alias)) continue;
    await db.insert(modelMappings).values({
      id: nanoid(),
      alias: mapping.alias,
      provider: mapping.provider,
      actualModel: mapping.actual_model,
      displayName: mapping.alias,
      reasoningEffort: mapping.reasoning_effort ?? null,
      priority: 0,
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
}
