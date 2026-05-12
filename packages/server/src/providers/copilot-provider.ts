import type { ExecuteOptions, ExecuteResult, ProviderConfigYaml } from '@star-cliproxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';

/**
 * GitHub Copilot CLI 프로바이더
 *
 * copilot -p "PROMPT" -s --no-ask-user 로 비대화형 실행.
 * 출력은 plain text (JSON 모드 없음) → PlainTextParser 사용.
 *
 * 인증: COPILOT_GITHUB_TOKEN 환경변수 또는 사전 OAuth 로그인 필요.
 * 도구 실행 차단: --deny-tool=shell --deny-tool=write (읽기 전용 모드)
 */
export class CopilotProvider extends BaseProvider {
  readonly name = 'copilot' as const;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser(); // PlainTextParser (빌트인 파서 미등록 → 폴백)
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const model = options.model || this.config.default_model;
    const prompt = convertMessagesToSinglePrompt(options.messages);

    // 추론 수준 주입 (--effort).
    // Copilot은 low/medium/high/xhigh만 지원하므로 'max'는 'xhigh'로 폴백.
    // 사용자가 extra_args에 --effort/--reasoning-effort를 이미 넣었으면 건너뜀.
    const userHasEffort = this.config.extra_args.some(
      (arg) => arg === '--effort' || arg === '--reasoning-effort',
    );
    const reasoningArgs: string[] = [];
    if (options.reasoningEffort && !userHasEffort) {
      const effort = options.reasoningEffort === 'max' ? 'xhigh' : options.reasoningEffort;
      reasoningArgs.push('--effort', effort);
    }

    const args: string[] = [
      '-p', prompt,
      '-s',             // 메타데이터 제거, 순수 응답만 stdout 출력
      '--no-ask-user',  // 추가 질문 차단 (자동화 필수)
      ...reasoningArgs,
      ...this.config.extra_args,
      ...(model ? ['--model', model] : []),
    ];

    return args;
  }

  // Copilot CLI는 plain text 출력이므로 stdout 전체가 응답 내용
  protected override parseNonStreamOutput(stdout: string): ExecuteResult {
    const content = stdout.trim();
    const completionTokens = Math.ceil(content.length / 4);

    return {
      content,
      usage: {
        promptTokens: 0,
        completionTokens,
        totalTokens: completionTokens,
      },
      finishReason: 'stop',
    };
  }

  // 건강 체크: copilot --version
  // BaseProvider 기본 구현 사용 (--version)
}
