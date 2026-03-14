import type { ProviderName, ProviderConfigYaml } from '@star-cliproxy/shared';
import type { BaseProvider } from './base-provider.js';
import { ClaudeProvider } from './claude-provider.js';
import { CodexProvider } from './codex-provider.js';
import { GeminiProvider } from './gemini-provider.js';

export class ProviderRegistry {
  private providers = new Map<ProviderName, BaseProvider>();

  register(provider: BaseProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: ProviderName): BaseProvider | undefined {
    return this.providers.get(name);
  }

  getAll(): BaseProvider[] {
    return Array.from(this.providers.values());
  }

  has(name: ProviderName): boolean {
    return this.providers.has(name);
  }
}

// 설정 기반으로 활성화된 Provider들을 등록
export function createProviderRegistry(
  configs: Record<ProviderName, ProviderConfigYaml>,
): ProviderRegistry {
  const registry = new ProviderRegistry();

  if (configs.claude.enabled) {
    registry.register(new ClaudeProvider(configs.claude));
  }
  if (configs.codex.enabled) {
    registry.register(new CodexProvider(configs.codex));
  }
  if (configs.gemini.enabled) {
    registry.register(new GeminiProvider(configs.gemini));
  }

  return registry;
}
