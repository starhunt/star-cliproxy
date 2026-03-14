import type { ChatCompletionChunk, StreamChunk } from '@star-cliproxy/shared';
import { nanoid } from 'nanoid';

// CLI stdout 라인을 StreamChunk로 파싱하는 인터페이스
export interface StreamParser {
  parse(line: string): StreamChunk | null;
}

// Claude stream-json 파서
export class ClaudeStreamParser implements StreamParser {
  parse(line: string): StreamChunk | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    try {
      const data = JSON.parse(trimmed);

      if (data.type === 'assistant' && data.subtype === 'text_delta') {
        return { type: 'delta', content: data.text ?? '' };
      }

      if (data.type === 'result') {
        const usage = data.total_cost_usd != null ? {
          promptTokens: data.num_input_tokens ?? 0,
          completionTokens: data.num_output_tokens ?? 0,
          totalTokens: (data.num_input_tokens ?? 0) + (data.num_output_tokens ?? 0),
        } : undefined;
        return { type: 'done', usage };
      }

      // 그 외 이벤트 (system, tool_use 등)는 무시
      return null;
    } catch {
      // JSON 파싱 실패 시 텍스트로 처리
      return null;
    }
  }
}

// Codex stdout 파서 (plain text 청크)
export class CodexStreamParser implements StreamParser {
  parse(line: string): StreamChunk | null {
    if (!line) return null;

    try {
      const data = JSON.parse(line);
      // JSONL 형식인 경우
      if (data.type === 'message' && data.content) {
        return { type: 'delta', content: data.content };
      }
      if (data.type === 'completed') {
        return { type: 'done' };
      }
      // 일반 텍스트로 fallback
      return { type: 'delta', content: line };
    } catch {
      // plain text 출력
      return { type: 'delta', content: line };
    }
  }
}

// Gemini stream-json 파서
export class GeminiStreamParser implements StreamParser {
  parse(line: string): StreamChunk | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    try {
      const data = JSON.parse(trimmed);

      if (data.type === 'text_delta') {
        return { type: 'delta', content: data.content ?? data.text ?? '' };
      }

      if (data.type === 'turn_complete' || data.type === 'result') {
        return { type: 'done' };
      }

      // 텍스트 content 필드가 있으면 delta로 처리
      if (typeof data.content === 'string') {
        return { type: 'delta', content: data.content };
      }

      return null;
    } catch {
      // plain text
      return { type: 'delta', content: trimmed };
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
