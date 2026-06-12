// config loader Zod 검증 테스트 (#30)
// 기존 동작 보존(기본값 폴백, env 치환, null 허용) + 신규 fail-fast 검증

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SERVER_PORT,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RATE_LIMIT_RPM,
} from '@star-cliproxy/shared';
import { loadConfig } from './loader.js';

let tempDir: string;

function writeConfig(yaml: string): string {
  const path = join(tempDir, 'config.yaml');
  writeFileSync(path, yaml, 'utf-8');
  return path;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cliproxy-config-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('loadConfig — 기존 동작 보존', () => {
  it('config 파일이 없으면 전체 기본값을 반환한다', () => {
    const config = loadConfig(join(tempDir, 'nonexistent.yaml'));

    expect(config.server.port).toBe(DEFAULT_SERVER_PORT);
    expect(config.dashboard.port).toBe(DEFAULT_DASHBOARD_PORT);
    expect(config.providers.claude.cli_path).toBe('claude');
    expect(config.providers.claude.max_concurrent).toBe(DEFAULT_MAX_CONCURRENT);
    expect(config.rateLimits.global.rpm).toBe(DEFAULT_RATE_LIMIT_RPM);
    expect(config.modelMappings.length).toBeGreaterThan(0);
  });

  it('유효한 config 값이 그대로 반영된다', () => {
    const path = writeConfig(`
server:
  port: 9999
  host: "0.0.0.0"
providers:
  claude:
    enabled: false
    cli_path: "/usr/local/bin/claude"
    timeout_ms: 60000
model_mappings:
  - alias: "my-model"
    provider: "claude"
    actual_model: "claude-sonnet-4-6"
`);
    const config = loadConfig(path);

    expect(config.server.port).toBe(9999);
    expect(config.server.host).toBe('0.0.0.0');
    expect(config.providers.claude.enabled).toBe(false);
    expect(config.providers.claude.cli_path).toBe('/usr/local/bin/claude');
    expect(config.providers.claude.timeout_ms).toBe(60000);
    // 미지정 필드는 기본값 유지
    expect(config.providers.claude.max_concurrent).toBe(DEFAULT_MAX_CONCURRENT);
    expect(config.providers.codex.timeout_ms).toBe(DEFAULT_TIMEOUT_MS);
    expect(config.modelMappings).toEqual([
      {
        alias: 'my-model',
        provider: 'claude',
        actual_model: 'claude-sonnet-4-6',
        reasoning_effort: undefined,
        provider_overrides: undefined,
      },
    ]);
  });

  it('null 값(빈 env var 치환 등)은 기본값으로 폴백한다', () => {
    // YAML에서 "port:" 처럼 값이 비면 null — 기존 ?? 폴백 동작 유지
    const path = writeConfig(`
server:
  port:
  host:
cache:
  enabled:
`);
    const config = loadConfig(path);

    expect(config.server.port).toBe(DEFAULT_SERVER_PORT);
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.cache.enabled).toBe(true);
  });

  it('환경변수 치환(${VAR})이 동작한다', () => {
    process.env.TEST_CLIPROXY_TOKEN = 'secret-token-123';
    try {
      const path = writeConfig(`
auth:
  admin_token: "\${TEST_CLIPROXY_TOKEN}"
`);
      const config = loadConfig(path);
      expect(config.auth.adminToken).toBe('secret-token-123');
    } finally {
      delete process.env.TEST_CLIPROXY_TOKEN;
    }
  });

  it('알 수 없는 키는 무시한다 (전방 호환)', () => {
    const path = writeConfig(`
server:
  port: 9999
  future_option: true
totally_new_section:
  foo: bar
`);
    const config = loadConfig(path);
    expect(config.server.port).toBe(9999);
  });

  it('커스텀 프로바이더가 빌트인과 함께 병합된다', () => {
    const path = writeConfig(`
providers:
  my-ollama:
    enabled: true
    cli_path: "ollama"
    default_model: "llama3"
`);
    const config = loadConfig(path);

    expect(config.providers['my-ollama'].cli_path).toBe('ollama');
    expect(config.providers['my-ollama'].default_model).toBe('llama3');
    expect(config.providers.claude).toBeDefined();
    expect(config.rateLimits.perProvider['my-ollama']).toEqual({ rpm: 20 });
  });

  it('reasoning_effort 미지원 값은 조용히 무시한다 (기존 동작)', () => {
    const path = writeConfig(`
model_mappings:
  - alias: "m1"
    provider: "claude"
    actual_model: "x"
    reasoning_effort: "ultra-mega"
`);
    const config = loadConfig(path);
    expect(config.modelMappings[0].reasoning_effort).toBeUndefined();
  });

  it('provider_overrides 비화이트리스트 키는 조용히 드롭한다 (기존 동작)', () => {
    const path = writeConfig(`
model_mappings:
  - alias: "m1"
    provider: "codex"
    actual_model: "x"
    provider_overrides:
      timeout_ms: 5000
      cli_path: "/evil/path"
      mode: "sdk"
`);
    const config = loadConfig(path);
    expect(config.modelMappings[0].provider_overrides).toEqual({ timeout_ms: 5000 });
  });
});

describe('loadConfig — Zod fail-fast 검증 (#30)', () => {
  it('server.port가 숫자가 아니면 경로를 포함한 에러를 던진다', () => {
    const path = writeConfig(`
server:
  port: "abc"
`);
    expect(() => loadConfig(path)).toThrow(/server\.port/);
  });

  it('server.port가 유효 범위(1-65535)를 벗어나면 에러를 던진다', () => {
    const path = writeConfig(`
server:
  port: 70000
`);
    expect(() => loadConfig(path)).toThrow(/server\.port/);
  });

  it('provider timeout_ms가 음수이면 에러를 던진다', () => {
    const path = writeConfig(`
providers:
  claude:
    timeout_ms: -1
`);
    expect(() => loadConfig(path)).toThrow(/providers\.claude\.timeout_ms/);
  });

  it('cache.enabled가 불리언이 아니면 에러를 던진다', () => {
    const path = writeConfig(`
cache:
  enabled: "yes please"
`);
    expect(() => loadConfig(path)).toThrow(/cache\.enabled/);
  });

  it('model_mappings에 alias가 없으면 에러를 던진다', () => {
    const path = writeConfig(`
model_mappings:
  - provider: "claude"
    actual_model: "claude-sonnet-4-6"
`);
    expect(() => loadConfig(path)).toThrow(/model_mappings/);
  });

  it('model_mappings에 provider가 없으면 에러를 던진다', () => {
    const path = writeConfig(`
model_mappings:
  - alias: "my-model"
    actual_model: "claude-sonnet-4-6"
`);
    expect(() => loadConfig(path)).toThrow(/model_mappings/);
  });

  it('extra_args에 문자열이 아닌 항목이 있으면 에러를 던진다', () => {
    const path = writeConfig(`
providers:
  claude:
    extra_args:
      - "--flag"
      - 123
`);
    expect(() => loadConfig(path)).toThrow(/extra_args/);
  });

  it('mode가 허용 값이 아니면 에러를 던진다', () => {
    const path = writeConfig(`
providers:
  codex:
    mode: "turbo"
`);
    expect(() => loadConfig(path)).toThrow(/mode/);
  });

  it('에러 메시지에 config 파일 경로가 포함된다', () => {
    const path = writeConfig(`
server:
  port: "abc"
`);
    expect(() => loadConfig(path)).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

describe('loadConfig — 실제 예제 config 회귀', () => {
  it('저장소의 config.example.yaml이 검증을 통과한다', () => {
    // 프로젝트 루트의 예제 config — 스키마가 실제 사용 형태와 어긋나지 않는지 보증
    const examplePath = join(import.meta.dirname, '../../../../config.example.yaml');
    expect(() => loadConfig(examplePath)).not.toThrow();
  });
});
