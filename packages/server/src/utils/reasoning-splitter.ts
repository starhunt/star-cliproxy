// 추론 모델 응답에서 thinking 영역과 최종 답변을 분리한다.
//
// 다양한 추론 백엔드가 만들어내는 4가지 케이스를 모두 다룬다:
//   1. 분리 필드: `message.reasoning_content` 또는 `delta.reasoning_content`
//      → provider 단에서 이미 분리되어 들어오므로 이 함수는 호출되지 않는다.
//   2. 표준 마커: content = "<think>본문</think>\n\n답변"
//   3. 시작 태그 누락 (Qwen3/DeepSeek-R1 등 chat_template prefix 흡수 케이스):
//      content = "본문</think>\n\n답변"
//   4. 마커 없음: content = "그냥 답변" (추론 모델 아님)
//
// 모든 경우에 `<think>` 시작/`</think>` 종료 마커가 결과 텍스트에 남지 않도록 잘라낸다.

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

export interface SplitResult {
  reasoning: string;
  content: string;
}

// </think>가 본문 텍스트로 등장한 케이스를 false positive 분리에서 보호.
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

/** 완성된 content 문자열을 reasoning/content로 분리한다. (비스트림 응답용)
 *
 * 안전장치: 종료 마커(`</think>`)가 정확히 1개일 때만 분리한다.
 * - 0개: 마커 없음 → 그대로 통과
 * - 2개 이상: 답변 본문에 `</think>` 텍스트가 포함된 케이스 가능성 (메타 질문/HTML 설명 등)
 *   → 잘못 분리하면 답변 중간이 잘리므로 분리하지 않고 통과 (false positive 방지).
 */
export function splitReasoning(raw: string): SplitResult {
  if (!raw) return { reasoning: '', content: '' };

  const closeCount = countOccurrences(raw, CLOSE_TAG);
  if (closeCount !== 1) {
    return { reasoning: '', content: raw };
  }

  const closeIdx = raw.indexOf(CLOSE_TAG);
  // 종료 마커 이전 = thinking 영역, 이후 = 최종 답변.
  let beforeClose = raw.slice(0, closeIdx);
  const afterClose = raw.slice(closeIdx + CLOSE_TAG.length);

  // 시작 태그가 있으면 제거 (있어도 없어도 OK — Qwen3 prefix 흡수 케이스 포함).
  const openIdx = beforeClose.indexOf(OPEN_TAG);
  if (openIdx !== -1) {
    beforeClose = beforeClose.slice(openIdx + OPEN_TAG.length);
  }

  return {
    reasoning: beforeClose.replace(/^\s+|\s+$/g, ''),
    content: afterClose.replace(/^\s+/, ''),
  };
}

/**
 * 스트리밍 응답을 점진적으로 분리.
 *
 * 사용법:
 *   const splitter = new ReasoningSplitter();
 *   for (const delta of stream) {
 *     const { reasoning, content } = splitter.push(delta);
 *     if (reasoning) emitThinking(reasoning);
 *     if (content) emitContent(content);
 *   }
 *   const tail = splitter.flush();  // 마지막 trailing 잔여물
 *
 * 부분 종료 토큰("</thi"... 같은) 안전 처리: 끝의 CLOSE_TAG.length - 1자는 다음 push까지 보류.
 */
export class ReasoningSplitter {
  private mode: 'thinking' | 'content' = 'thinking';
  private buffer = '';
  private seenAnyToken = false;

  push(delta: string): { reasoning: string; content: string } {
    if (!delta) return { reasoning: '', content: '' };

    // 첫 토큰 검사 — `<think>`로 시작하지 않고 일반 텍스트면 thinking 모드를 그대로 두지만
    // 응답 자체에 종료 마커가 없을 가능성도 있어 보류 버퍼로 안전 flush.
    if (!this.seenAnyToken) {
      this.seenAnyToken = true;
      // 시작 태그가 prefix면 제거 (있을 때만).
      if (delta.startsWith(OPEN_TAG)) {
        delta = delta.slice(OPEN_TAG.length);
      }
    }

    this.buffer += delta;

    if (this.mode === 'content') {
      const out = this.buffer;
      this.buffer = '';
      return { reasoning: '', content: out };
    }

    // thinking 모드 — 종료 마커 탐지.
    const closeIdx = this.buffer.indexOf(CLOSE_TAG);
    if (closeIdx !== -1) {
      const reasoning = this.buffer.slice(0, closeIdx);
      const trailing = this.buffer.slice(closeIdx + CLOSE_TAG.length);
      this.buffer = '';
      this.mode = 'content';
      return {
        reasoning,
        content: trailing.replace(/^\s+/, ''),
      };
    }

    // 부분 종료 토큰 가능성 고려: 끝 (CLOSE_TAG.length - 1)자는 다음 push까지 보류.
    const safeLen = Math.max(this.buffer.length - (CLOSE_TAG.length - 1), 0);
    if (safeLen === 0) {
      return { reasoning: '', content: '' };
    }
    const safe = this.buffer.slice(0, safeLen);
    this.buffer = this.buffer.slice(safeLen);
    return { reasoning: safe, content: '' };
  }

  /** 스트림 종료 시 잔여물. thinking 모드면 reasoning으로, content 모드면 content로. */
  flush(): { reasoning: string; content: string } {
    const tail = this.buffer;
    this.buffer = '';
    if (!tail) return { reasoning: '', content: '' };
    return this.mode === 'thinking'
      ? { reasoning: tail, content: '' }
      : { reasoning: '', content: tail };
  }

  get isInThinking(): boolean {
    return this.mode === 'thinking';
  }
}
