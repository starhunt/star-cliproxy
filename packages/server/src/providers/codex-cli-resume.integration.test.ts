import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { readdirSync, unlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExecuteOptions, ProviderConfigYaml } from '@star-cliproxy/shared';
import { CodexProvider } from './codex-provider.js';

const codexInstalled = (() => {
  try {
    execSync('which codex', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function baseCodexConfig(extra: Partial<ProviderConfigYaml> = {}): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: 'codex',
    default_model: 'gpt-5.5',
    max_concurrent: 1,
    timeout_ms: 120000,
    extra_args: ['--skip-git-repo-check', '-s', 'read-only'],
    ...extra,
  };
}

function baseOptions(extra: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    model: 'gpt-5.5',
    stream: false,
    ...extra,
  };
}

// 테스트가 생성한 codex 세션 jsonl을 cleanup (정책상 보존이지만 test artifact는 정리)
function cleanupRecentCodexSessions(thresholdMs: number): void {
  const root = join(homedir(), '.codex', 'sessions');
  const now = Date.now();
  function walk(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        walk(full);
      } else if (name.endsWith('.jsonl') && now - stat.mtimeMs < thresholdMs) {
        try { unlinkSync(full); } catch { /* ignore */ }
      }
    }
  }
  walk(root);
}

const TEST_START = Date.now();

describe.skipIf(!codexInstalled)('CodexProvider CLI resume (integration)', () => {
  let provider: CodexProvider;

  beforeAll(() => {
    provider = new CodexProvider(baseCodexConfig());
  });

  afterAll(() => {
    provider.destroyCliSessionManager();
    cleanupRecentCodexSessions(Date.now() - TEST_START + 60_000);
  });

  it('시나리오 A: 같은 clientKey로 2회 호출 시 두 번째 호출이 첫 컨텍스트 재사용', async () => {
    const clientKey = `test-A-${Date.now()}`;
    const options = (msg: string) => baseOptions({
      messages: [{ role: 'user', content: msg }],
      clientKey,
      providerOverrides: {
        cli_options: { enable_session_reuse: true, session_ttl_ms: 60_000 },
      },
    });

    // 1차: 이름 알림
    const r1 = await provider.execute(options('내 이름은 BarTest이고 좋아하는 숫자는 42야. 짧게 인사만 해줘.'));
    expect(r1.meta?.threadId).toBeTruthy();
    expect(r1.meta?.threadReused).toBe(false);
    const threadId1 = r1.meta!.threadId!;

    // 2차: 같은 clientKey, 컨텍스트 확인. resume args가 사용되어야 함.
    const r2 = await provider.execute(options('내 이름이 뭐였지? 한 단어로만 답해.'));
    expect(r2.meta?.threadId).toBe(threadId1); // 같은 thread
    expect(r2.meta?.threadReused).toBe(true);
    expect(r2.content.toLowerCase()).toContain('bartest');
  }, 180_000);

  it('시나리오 B: 같은 provider 인스턴스에 다른 overrides → 다른 args (resume 분기 무효)', () => {
    const sm = provider.getCliSessionManager();
    // 첫 시나리오에서 thread가 캐싱돼 있을 수 있음 — overrides가 disable이면 무시되어야 함
    const argsResume = (provider as any).buildArgs(baseOptions({
      clientKey: 'shared-X',
      providerOverrides: { cli_options: { enable_session_reuse: true } },
    }));
    // shared-X는 처음이므로 resume 아님
    expect(argsResume).not.toContain('resume');

    // session_reuse=false면 SessionManager에 thread가 있어도 resume 사용하지 않음
    if (sm) sm.set('shared-X', 'tid-DUMMY', 'gpt-5.5');
    const argsNoReuse = (provider as any).buildArgs(baseOptions({
      clientKey: 'shared-X',
      providerOverrides: { cli_options: { enable_session_reuse: false } },
    }));
    expect(argsNoReuse).not.toContain('resume');
    expect(argsNoReuse[0]).toBe('exec');
    expect(argsNoReuse[1]).toBe('--json');
  });
});

describe.skipIf(codexInstalled)('CodexProvider CLI resume (integration) — skipped: codex CLI not installed', () => {
  it('placeholder', () => {
    expect(codexInstalled).toBe(false);
  });
});
