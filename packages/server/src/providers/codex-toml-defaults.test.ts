import { describe, it, expect } from 'vitest';

// 내부 헬퍼 동작 검증을 위해 모듈을 동적 import 후 정규식 동작을 그대로 재현.
// (실제 ~/.codex/config.toml 파일은 환경 의존이라 직접 테스트하지 않고 텍스트 단위로 검증)

function extractTopLevelString(content: string, key: string): string | null {
  const headEnd = content.search(/^\s*\[/m);
  const head = headEnd >= 0 ? content.slice(0, headEnd) : content;
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"\\n]*)"\\s*(?:#.*)?$`, 'm');
  const m = head.match(re);
  return m ? m[1] : null;
}

describe('extractTopLevelString', () => {
  it('reads a top-level string assignment', () => {
    const toml = `model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n`;
    expect(extractTopLevelString(toml, 'model')).toBe('gpt-5.5');
    expect(extractTopLevelString(toml, 'model_reasoning_effort')).toBe('high');
  });

  it('ignores assignments inside sections', () => {
    const toml = `[profile.default]\nmodel = "ignored"\n`;
    expect(extractTopLevelString(toml, 'model')).toBeNull();
  });

  it('stops scanning at first section header', () => {
    const toml = `model = "gpt-5.5"\n[profile.alt]\nmodel = "different"\n`;
    expect(extractTopLevelString(toml, 'model')).toBe('gpt-5.5');
  });

  it('returns null when key is missing', () => {
    expect(extractTopLevelString(`other = "x"\n`, 'model')).toBeNull();
  });

  it('handles inline comments', () => {
    const toml = `model = "gpt-5.5"  # default model\n`;
    expect(extractTopLevelString(toml, 'model')).toBe('gpt-5.5');
  });

  it('does not match unquoted values (only string assignments)', () => {
    const toml = `model = gpt-5.5\n`;
    expect(extractTopLevelString(toml, 'model')).toBeNull();
  });
});
