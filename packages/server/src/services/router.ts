import { eq, and, asc } from 'drizzle-orm';
import { BUILTIN_PROVIDERS, isReasoningEffort, type ProviderOverrides, type ReasoningEffort } from '@star-cliproxy/shared';
import { getDatabase } from '../db/client.js';
import { modelMappings } from '../db/schema.js';
import type { ProviderRegistry } from '../providers/provider-registry.js';

export interface ResolvedRoute {
  provider: string;
  actualModel: string;
  reasoningEffort?: ReasoningEffort;
  providerOverrides?: ProviderOverrides;
  // null=상속(전역 default), true/false=명시
  includeReasoning?: boolean | null;
  // 백엔드 비표준 필드 패스스루 (HTTP provider 전용)
  extraBody?: Record<string, unknown>;
}

// DB의 provider_overrides JSON 문자열을 파싱. 파싱 실패는 warn + null fallback.
function parseProviderOverrides(raw: string | null | undefined): ProviderOverrides | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ProviderOverrides;
    }
  } catch (e) {
    console.warn('[router] failed to parse provider_overrides:', (e as Error).message);
  }
  return undefined;
}

// extra_body JSON 파싱. 객체가 아니면 무시.
function parseExtraBody(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (e) {
    console.warn('[router] failed to parse extra_body:', (e as Error).message);
  }
  return undefined;
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
      .filter((m) => this.registry.has(m.provider))
      .map((m) => ({
        provider: m.provider,
        actualModel: m.actualModel,
        reasoningEffort: isReasoningEffort(m.reasoningEffort) ? m.reasoningEffort : undefined,
        providerOverrides: parseProviderOverrides(m.providerOverrides),
        includeReasoning: typeof m.includeReasoning === 'boolean' ? m.includeReasoning : null,
        extraBody: parseExtraBody(m.extraBody),
      }));
  }

  // 모델명에서 provider 추론 (접두사 기반, 오탐 방지)
  // "my-opus-experiment" 같은 사용자 정의 모델명이 잘못 라우팅되지 않도록
  // 공식 모델명 접두사 패턴만 매칭
  private inferProvider(model: string): string | null {
    const lower = model.toLowerCase();

    // Claude: claude-*, sonnet-*, opus-*, haiku-* 접두사
    if (/^(claude|claude-|sonnet-|opus-|haiku-)/.test(lower)) {
      return 'claude';
    }
    // Codex/OpenAI: gpt-*, o1-*, o3-*, o4-*, codex-* 접두사
    if (/^(gpt-|o1-|o3-|o4-|codex-)/.test(lower)) {
      return 'codex';
    }
    // Gemini: gemini-* 접두사
    if (/^gemini-/.test(lower)) {
      return 'gemini';
    }
    // Antigravity (agy): antigravity, antigravity-*, agy, agy-* 접두사
    if (/^(antigravity|agy)(-|$)/.test(lower)) {
      return 'agy';
    }
    // Grok: grok, grok-* 접두사
    if (/^grok(-|$)/.test(lower)) {
      return 'grok';
    }
    return null;
  }
}
