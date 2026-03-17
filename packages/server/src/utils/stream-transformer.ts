import type { ChatCompletionChunk, StreamChunk } from '@star-cliproxy/shared';
import { nanoid } from 'nanoid';

// CLI stdout 라인을 StreamChunk로 파싱하는 인터페이스
export interface StreamParser {
  parse(line: string): StreamChunk | null;
}

// Claude stream-json 파서 (--output-format stream-json --verbose)
// 실제 출력: init → assistant(전체 메시지) → rate_limit_event → result
export class ClaudeStreamParser implements StreamParser {
  parse(line: string): StreamChunk | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    try {
      const data = JSON.parse(trimmed);

      // assistant 이벤트: 전체 응답 텍스트 포함
      if (data.type === 'assistant' && data.message) {
        const content = data.message.content;
        if (Array.isArray(content)) {
          // content 배열에서 텍스트 추출
          const text = content
            .filter((c: { type: string }) => c.type === 'text')
            .map((c: { text: string }) => c.text)
            .join('');
          if (text) return { type: 'delta', content: text };
        }
        return null;
      }

      // result 이벤트: 토큰 사용량 포함
      if (data.type === 'result') {
        const u = data.usage;
        const usage = u ? {
          promptTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          completionTokens: u.output_tokens ?? 0,
          totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        } : undefined;
        return { type: 'done', usage };
      }

      return null;
    } catch {
      return null;
    }
  }
}

// Codex JSONL 파서 (--json 플래그)
// 실제 출력: thread.started → turn.started → item.completed(텍스트) → turn.completed(usage)
export class CodexStreamParser implements StreamParser {
  parse(line: string): StreamChunk | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    try {
      const data = JSON.parse(trimmed);

      // item.completed: 응답 텍스트 포함 (에러 아이템은 제외)
      if (data.type === 'item.completed' && data.item) {
        if (data.item.type === 'error') {
          return { type: 'error', error: data.item.message ?? 'Codex item error' };
        }
        const text = data.item.text ?? '';
        if (text) return { type: 'delta', content: text };
        return null;
      }

      // turn.completed: 토큰 사용량
      if (data.type === 'turn.completed') {
        const u = data.usage;
        const usage = u ? {
          promptTokens: u.input_tokens ?? 0,
          completionTokens: u.output_tokens ?? 0,
          totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
        } : undefined;
        return { type: 'done', usage };
      }

      // turn.failed: 에러
      if (data.type === 'turn.failed' || data.type === 'error') {
        return { type: 'error', error: data.error?.message ?? data.message ?? 'Codex error' };
      }

      return null;
    } catch {
      // plain text fallback
      if (trimmed) return { type: 'delta', content: trimmed };
      return null;
    }
  }
}

// Gemini stream-json 파서 (-o stream-json)
// 실제 출력: init → message(user) → message(delta=true, assistant) → result
// Gemini는 진짜 실시간 delta를 지원함
export class GeminiStreamParser implements StreamParser {
  parse(line: string): StreamChunk | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    try {
      const data = JSON.parse(trimmed);

      // assistant delta 메시지: 실시간 텍스트 조각
      if (data.type === 'message' && data.role === 'assistant' && data.delta === true) {
        const content = data.content ?? '';
        if (content) return { type: 'delta', content };
        return null;
      }

      // result 이벤트: 토큰 사용량
      if (data.type === 'result') {
        const stats = data.stats;
        const usage = stats ? {
          promptTokens: stats.input_tokens ?? 0,
          completionTokens: stats.output_tokens ?? 0,
          totalTokens: stats.total_tokens ?? ((stats.input_tokens ?? 0) + (stats.output_tokens ?? 0)),
        } : undefined;
        return { type: 'done', usage };
      }

      return null;
    } catch {
      return null;
    }
  }
}

// StreamChunk를 OpenAI SSE 형식으로 변환
export function formatAsSSE(
  chunk: StreamChunk,
  requestId: string,
  model: string,
): string | null {
  if (chunk.type === 'delta') {
    const data: ChatCompletionChunk = {
      id: requestId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: { content: chunk.content },
        finish_reason: null,
      }],
    };
    return `data: ${JSON.stringify(data)}\n\n`;
  }

  if (chunk.type === 'done') {
    const data: ChatCompletionChunk = {
      id: requestId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop',
      }],
    };
    return `data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`;
  }

  if (chunk.type === 'error') {
    return null;
  }

  return null;
}

export function createRequestId(): string {
  return `chatcmpl-proxy-${nanoid(24)}`;
}

export function getParserForProvider(provider: string): StreamParser {
  switch (provider) {
    case 'claude': return new ClaudeStreamParser();
    case 'codex': return new CodexStreamParser();
    case 'gemini': return new GeminiStreamParser();
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}
