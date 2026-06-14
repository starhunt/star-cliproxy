import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ProviderConfigYaml, ProviderOverrides } from '@star-cliproxy/shared';
import { mergeProviderConfig, _resetOverrideWarnCache } from './provider-override.js';

function baseConfig(extra: Partial<ProviderConfigYaml> = {}): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: 'codex',
    default_model: 'gpt-5.5',
    max_concurrent: 10,
    timeout_ms: 300000,
    extra_args: ['--skip-git-repo-check'],
    cli_options: { ephemeral: true },
    ...extra,
  };
}

describe('mergeProviderConfig', () => {
  beforeEach(() => {
    _resetOverrideWarnCache();
  });

  it('returns base copy when overrides는 undefined', () => {
    const base = baseConfig();
    const merged = mergeProviderConfig(base, undefined, 'codex');
    expect(merged).toEqual(base);
    expect(merged).not.toBe(base);  // 새 객체 보장
  });

  it('returns base copy when overrides는 빈 객체', () => {
    const base = baseConfig();
    const merged = mergeProviderConfig(base, {}, 'codex');
    expect(merged).toEqual(base);
  });

  it('cli_options 일부 키만 deep merge — 다른 키 보존', () => {
    const base = baseConfig({ cli_options: { ephemeral: true } });
    const overrides: ProviderOverrides = {
      cli_options: { enable_session_reuse: true, session_ttl_ms: 3600000 },
    };
    const merged = mergeProviderConfig(base, overrides, 'codex');
    expect(merged.cli_options).toEqual({
      ephemeral: true,
      enable_session_reuse: true,
      session_ttl_ms: 3600000,
    });
  });

  it('cli_options.ephemeral 오버라이드는 base 값을 교체', () => {
    const base = baseConfig({ cli_options: { ephemeral: true } });
    const overrides: ProviderOverrides = { cli_options: { ephemeral: false } };
    const merged = mergeProviderConfig(base, overrides, 'codex');
    expect(merged.cli_options?.ephemeral).toBe(false);
  });

  it('extra_args는 교체 (append 아님)', () => {
    const base = baseConfig({ extra_args: ['--a', '--b'] });
    const overrides: ProviderOverrides = { extra_args: ['--c'] };
    const merged = mergeProviderConfig(base, overrides, 'codex');
    expect(merged.extra_args).toEqual(['--c']);
  });

  it('timeout_ms / working_dir 화이트리스트 통과', () => {
    const base = baseConfig();
    const overrides: ProviderOverrides = { timeout_ms: 60000, working_dir: '/tmp/x' };
    const merged = mergeProviderConfig(base, overrides, 'codex');
    expect(merged.timeout_ms).toBe(60000);
    expect(merged.working_dir).toBe('/tmp/x');
  });

  it('base 인스턴스는 변형되지 않음 (불변성)', () => {
    const base = baseConfig({ cli_options: { ephemeral: true }, extra_args: ['--keep'] });
    const baseSnapshot = JSON.parse(JSON.stringify(base));
    mergeProviderConfig(base, {
      extra_args: ['--new'],
      cli_options: { ephemeral: false },
    }, 'codex');
    expect(base).toEqual(baseSnapshot);
  });

  it('알 수 없는 provider면 전체 drop + warn 1회', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = baseConfig();
    const merged = mergeProviderConfig(
      base,
      { cli_options: { ephemeral: false } },
      'unknown-provider',
    );
    expect(merged).toEqual(base);
    expect(warn).toHaveBeenCalledTimes(1);
    // 두 번째 호출은 dedupe되어 warn 안 됨
    mergeProviderConfig(base, { cli_options: { ephemeral: false } }, 'unknown-provider');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('claude mode와 channel_options를 whitelist 기반으로 병합한다', () => {
    const base = baseConfig({
      cli_path: 'claude',
      default_model: 'claude-sonnet-4-6',
      channel_options: {
        endpoint_url: 'http://old.example',
        poll_interval_ms: 1000,
      },
    });
    const overrides: ProviderOverrides = {
      mode: 'channel-worker',
      channel_options: {
        endpoint_url: 'http://127.0.0.1:8788',
        result_timeout_ms: 120000,
        isolation: 'external',
      },
    };

    const merged = mergeProviderConfig(base, overrides, 'claude');

    expect(merged.mode).toBe('channel-worker');
    expect(merged.channel_options).toEqual({
      endpoint_url: 'http://127.0.0.1:8788',
      poll_interval_ms: 1000,
      result_timeout_ms: 120000,
      isolation: 'external',
    });
  });
});
