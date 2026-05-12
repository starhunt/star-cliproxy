// ~/.codex/config.toml에서 글로벌 기본값(model, model_reasoning_effort)만 발췌.
// 본격적인 TOML 파서를 도입하지 않고 정규식으로 최상위 키만 안전하게 추출.
// 섹션(`[section]`)이나 인라인 테이블 안의 동일 키는 건너뜀.
//
// 보안:
// - 파일 경로는 `homedir() + .codex/config.toml`로 고정 — 외부 입력 없음.
// - 결과값은 reasoning effort 화이트리스트로 검증 후 노출.
// - 파일이 없거나 권한 없으면 silently null 반환.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isReasoningEffort, type ReasoningEffort } from '@star-cliproxy/shared';

export interface CodexCliDefaults {
  configPath: string;
  exists: boolean;
  model: string | null;
  modelReasoningEffort: ReasoningEffort | null;
}

const CONFIG_PATH = join(homedir(), '.codex', 'config.toml');

// 최상위 키만 매칭 (라인 시작 + 키 + '=' + 값). 섹션 헤더 이전까지만 스캔.
function extractTopLevelString(content: string, key: string): string | null {
  // 섹션 시작 전까지의 헤드 영역만 본다
  const headEnd = content.search(/^\s*\[/m);
  const head = headEnd >= 0 ? content.slice(0, headEnd) : content;

  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"\\n]*)"\\s*(?:#.*)?$`, 'm');
  const m = head.match(re);
  return m ? m[1] : null;
}

export function readCodexCliDefaults(): CodexCliDefaults {
  const base: CodexCliDefaults = {
    configPath: CONFIG_PATH,
    exists: false,
    model: null,
    modelReasoningEffort: null,
  };

  if (!existsSync(CONFIG_PATH)) {
    return base;
  }

  let content: string;
  try {
    content = readFileSync(CONFIG_PATH, 'utf-8');
  } catch {
    return { ...base, exists: true };
  }

  const model = extractTopLevelString(content, 'model');
  const rawEffort = extractTopLevelString(content, 'model_reasoning_effort');
  const effort = rawEffort && isReasoningEffort(rawEffort.toLowerCase())
    ? (rawEffort.toLowerCase() as ReasoningEffort)
    : null;

  return {
    configPath: CONFIG_PATH,
    exists: true,
    model,
    modelReasoningEffort: effort,
  };
}
