import { describe, it, expect } from 'vitest';
import type { ExecuteOptions, ProviderConfigYaml } from '@star-cliproxy/shared';
import { ClaudeProvider } from './claude-provider.js';
import { CodexProvider } from './codex-provider.js';
import { CopilotProvider } from './copilot-provider.js';

// 테스트용 기본 config
function baseConfig(extra: Partial<ProviderConfigYaml> = {}): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: 'cli',
    default_model: 'm',
    max_concurrent: 1,
    timeout_ms: 30000,
    extra_args: [],
    ...extra,
  };
}

function baseOptions(extra: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    model: 'm',
    stream: false,
    ...extra,
  };
}

// buildArgs는 protected이므로 캐스트로 호출
function callBuildArgs(p: unknown, opts: ExecuteOptions): string[] {
  return (p as { buildArgs: (o: ExecuteOptions) => string[] }).buildArgs(opts);
}

describe('ClaudeProvider buildArgs — reasoning_effort', () => {
  it('reasoningEffort 미지정 시 --effort 플래그 없음', () => {
    const p = new ClaudeProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions());
    expect(args).not.toContain('--effort');
  });

  it('reasoningEffort=high면 --effort high 주입', () => {
    const p = new ClaudeProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'high' }));
    const idx = args.indexOf('--effort');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('high');
  });

  it('xhigh/max도 그대로 전달 (Claude 네이티브 지원)', () => {
    const p = new ClaudeProvider(baseConfig());
    expect(callBuildArgs(p, baseOptions({ reasoningEffort: 'xhigh' }))).toContain('xhigh');
    expect(callBuildArgs(p, baseOptions({ reasoningEffort: 'max' }))).toContain('max');
  });

  it('extra_args에 사용자가 직접 --effort 넣었으면 자동 주입 안 함', () => {
    const p = new ClaudeProvider(baseConfig({ extra_args: ['--effort', 'low'] }));
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'high' }));
    // --effort는 사용자가 직접 넣은 것 하나만 존재
    const occurrences = args.filter((a) => a === '--effort').length;
    expect(occurrences).toBe(1);
  });
});

describe('CodexProvider buildArgs — reasoning_effort', () => {
  it('reasoningEffort 미지정 시 model_reasoning_effort 없음', () => {
    const p = new CodexProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions());
    expect(args.some((a) => a.startsWith('model_reasoning_effort'))).toBe(false);
  });

  it('reasoningEffort=medium이면 -c model_reasoning_effort=medium 주입', () => {
    const p = new CodexProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'medium' }));
    expect(args).toContain('-c');
    expect(args).toContain('model_reasoning_effort=medium');
  });

  it('xhigh는 high로 폴백', () => {
    const p = new CodexProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'xhigh' }));
    expect(args).toContain('model_reasoning_effort=high');
  });

  it('max도 high로 폴백', () => {
    const p = new CodexProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'max' }));
    expect(args).toContain('model_reasoning_effort=high');
  });

  it('extra_args에 model_reasoning_effort 직접 넣었으면 자동 주입 안 함', () => {
    const p = new CodexProvider(baseConfig({
      extra_args: ['-c', 'model_reasoning_effort=low'],
    }));
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'high' }));
    const efforts = args.filter((a) => a.startsWith('model_reasoning_effort='));
    expect(efforts).toEqual(['model_reasoning_effort=low']);
  });
});

describe('CopilotProvider buildArgs — reasoning_effort', () => {
  it('reasoningEffort 미지정 시 --effort 없음', () => {
    const p = new CopilotProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions());
    expect(args).not.toContain('--effort');
  });

  it('reasoningEffort=high이면 --effort high 주입', () => {
    const p = new CopilotProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'high' }));
    const idx = args.indexOf('--effort');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('high');
  });

  it('max는 xhigh로 폴백 (Copilot은 max 미지원)', () => {
    const p = new CopilotProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'max' }));
    const idx = args.indexOf('--effort');
    expect(args[idx + 1]).toBe('xhigh');
  });

  it('extra_args에 --reasoning-effort 별칭 넣었으면 자동 주입 안 함', () => {
    const p = new CopilotProvider(baseConfig({ extra_args: ['--reasoning-effort', 'low'] }));
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'high' }));
    expect(args).not.toContain('--effort');
  });
});
