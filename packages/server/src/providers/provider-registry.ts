import type { ProviderConfigYaml } from '@star-cliproxy/shared';
import type { BaseProvider } from './base-provider.js';
import { ClaudeProvider } from './claude-provider.js';
import { CodexProvider } from './codex-provider.js';
import { GeminiProvider } from './gemini-provider.js';

export class ProviderRegistry {
  private providers = new Map<string, BaseProvider>();

  register(provider: BaseProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): BaseProvider | undefined {
    return this.providers.get(name);
  }

  getAll(): BaseProvider[] {
    return Array.from(this.providers.values());
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }
}

// cli_path 검증: 허용된 문자만 (영숫자, -, _, ., /, \, :)
const SAFE_CLI_PATH = /^[a-zA-Z0-9_\-./\\:]+$/;

function validateCliPath(provider: string, cliPath: string): void {
  if (!SAFE_CLI_PATH.test(cliPath)) {
    throw new Error(`Unsafe cli_path for ${provider}: "${cliPath}". Only alphanumeric, -, _, ., /, \\, : allowed.`);
  }
}

// 빌트인 프로바이더 팩토리
type ProviderFactory = (config: ProviderConfigYaml) => BaseProvider;

const builtinFactories: Record<string, ProviderFactory> = {
  claude: (config) => new ClaudeProvider(config),
  codex: (config) => new CodexProvider(config),
  gemini: (config) => new GeminiProvider(config),
};

// 설정 기반으로 활성화된 Provider들을 등록
export function createProviderRegistry(
  configs: Record<string, ProviderConfigYaml>,
): ProviderRegistry {
  const registry = new ProviderRegistry();

  for (const [name, config] of Object.entries(configs)) {
    if (!config.enabled) continue;

    validateCliPath(name, config.cli_path);

    const factory = builtinFactories[name];
    if (factory) {
      registry.register(factory(config));
    }
    // 빌트인이 아닌 프로바이더는 플러그인 로더에서 등록
  }

  return registry;
}
