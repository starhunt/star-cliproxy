import type { ExecuteOptions, ProviderConfigYaml } from '@star-cliproxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';

export class GeminiProvider extends BaseProvider {
  readonly name = 'gemini' as const;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const prompt = convertMessagesToSinglePrompt(options.messages);
    const model = options.model || this.config.default_model;

    const args: string[] = [
      '-p', prompt,
      '-m', model,
      '-o', options.stream ? 'stream-json' : 'json',
    ];

    // 추가 인수 (--approval-mode yolo 등)
    args.push(...this.config.extra_args);

    return args;
  }
}
