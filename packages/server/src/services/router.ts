import { eq, and, asc } from 'drizzle-orm';
import type { ProviderName } from '@star-cliproxy/shared';
import { getDatabase } from '../db/client.js';
import { modelMappings } from '../db/schema.js';
import type { ProviderRegistry } from '../providers/provider-registry.js';

export interface ResolvedRoute {
  provider: ProviderName;
  actualModel: string;
}

export class ModelRouter {
  private registry: ProviderRegistry;

  constructor(registry: ProviderRegistry) {
    this.registry = registry;
  }

  // 모델 alias를 provider + actual_model로 해석 (priority순 폴백 포함)
  async resolve(modelAlias: string): Promise<ResolvedRoute[]> {
    const db = getDatabase();

    const mappings = await db
      .select()
      .from(modelMappings)
      .where(and(
        eq(modelMappings.alias, modelAlias),
        eq(modelMappings.enabled, true),
      ))
      .orderBy(asc(modelMappings.priority));

    if (mappings.length === 0) {
      // 매핑이 없으면 alias를 그대로 모델명으로 사용 시도
      // provider를 alias에서 추론
      const inferredProvider = this.inferProvider(modelAlias);
      if (inferredProvider) {
        return [{ provider: inferredProvider, actualModel: modelAlias }];
      }
      return [];
    }

    // 활성화된 provider만 필터링
    return mappings
      .filter((m) => this.registry.has(m.provider as ProviderName))
      .map((m) => ({
        provider: m.provider as ProviderName,
        actualModel: m.actualModel,
      }));
  }

  // 모델명에서 provider 추론
  private inferProvider(model: string): ProviderName | null {
    const lower = model.toLowerCase();
    if (lower.includes('claude') || lower.includes('sonnet') || lower.includes('opus') || lower.includes('haiku')) {
      return 'claude';
    }
    if (lower.includes('gpt') || lower.includes('o4') || lower.includes('o3') || lower.includes('codex')) {
      return 'codex';
    }
    if (lower.includes('gemini')) {
      return 'gemini';
    }
    return null;
  }
}
