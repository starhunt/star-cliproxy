import type { ProviderConfigYaml, ProviderOverrides } from '@star-cliproxy/shared';
import { CODEX_OVERRIDE_ALLOWED_KEYS } from '@star-cliproxy/shared';

// codex 화이트리스트 키 셋 (런타임 검색용)
const CODEX_ALLOWED_SET = new Set<string>(CODEX_OVERRIDE_ALLOWED_KEYS);

// 화이트리스트 매핑: provider명 → 허용 dotted key 셋
const ALLOWED_BY_PROVIDER: Record<string, Set<string>> = {
  codex: CODEX_ALLOWED_SET,
};

// 화이트리스트 외 키를 발견했을 때 한 번만 경고 (provider+key 단위 dedupe)
const warnedKeys = new Set<string>();

function warnUnallowed(provider: string, key: string): void {
  const dedupeKey = `${provider}:${key}`;
  if (warnedKeys.has(dedupeKey)) return;
  warnedKeys.add(dedupeKey);
  console.warn(`[provider-override] '${key}' is not in the whitelist for provider '${provider}' — ignored.`);
}

// ProviderOverrides를 base ProviderConfigYaml에 deep merge.
// 화이트리스트(provider별) 외 키는 silent drop + warn 로그. 동일 dedupeKey는 1회만 경고.
// 배열(extra_args)은 **교체** (append 정책은 추후 확장).
// 결과는 항상 새 객체 — base와 overrides 인스턴스 모두 변형되지 않음.
export function mergeProviderConfig(
  base: ProviderConfigYaml,
  overrides: ProviderOverrides | undefined,
  provider: string,
): ProviderConfigYaml {
  if (!overrides || Object.keys(overrides).length === 0) {
    return { ...base };
  }

  const allowed = ALLOWED_BY_PROVIDER[provider];
  if (!allowed) {
    // 해당 provider에 화이트리스트 정의 없음 — 전체 drop + warn
    warnUnallowed(provider, '*');
    return { ...base };
  }

  const merged: ProviderConfigYaml = {
    ...base,
    cli_options: base.cli_options ? { ...base.cli_options } : undefined,
  };

  if (overrides.extra_args !== undefined) {
    if (allowed.has('extra_args')) merged.extra_args = [...overrides.extra_args];
    else warnUnallowed(provider, 'extra_args');
  }
  if (overrides.timeout_ms !== undefined) {
    if (allowed.has('timeout_ms')) merged.timeout_ms = overrides.timeout_ms;
    else warnUnallowed(provider, 'timeout_ms');
  }
  if (overrides.working_dir !== undefined) {
    if (allowed.has('working_dir')) merged.working_dir = overrides.working_dir;
    else warnUnallowed(provider, 'working_dir');
  }
  if (overrides.cli_options) {
    const cli = merged.cli_options ?? {};
    if (overrides.cli_options.ephemeral !== undefined) {
      if (allowed.has('cli_options.ephemeral')) cli.ephemeral = overrides.cli_options.ephemeral;
      else warnUnallowed(provider, 'cli_options.ephemeral');
    }
    if (overrides.cli_options.enable_session_reuse !== undefined) {
      if (allowed.has('cli_options.enable_session_reuse')) cli.enable_session_reuse = overrides.cli_options.enable_session_reuse;
      else warnUnallowed(provider, 'cli_options.enable_session_reuse');
    }
    if (overrides.cli_options.session_ttl_ms !== undefined) {
      if (allowed.has('cli_options.session_ttl_ms')) cli.session_ttl_ms = overrides.cli_options.session_ttl_ms;
      else warnUnallowed(provider, 'cli_options.session_ttl_ms');
    }
    merged.cli_options = cli;
  }

  return merged;
}

// 테스트 전용 — warn 캐시 초기화
export function _resetOverrideWarnCache(): void {
  warnedKeys.clear();
}
