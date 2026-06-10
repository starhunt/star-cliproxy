import type {
  ChatCompletionChunk,
  StreamChunk,
  StreamParser,
  ProviderEvent,
  TokenUsage,
} from '@star-cliproxy/shared';
import { nanoid } from 'nanoid';

// StreamParser는 @star-cliproxy/shared에서 re-export
export type { StreamParser } from '@star-cliproxy/shared';

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

  parseEvents(line: string): ProviderEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    try {
      const data = JSON.parse(trimmed);

      // assistant 이벤트: content 배열의 각 블록을 개별 이벤트로 변환
      if (data.type === 'assistant' && data.message) {
        const content = data.message.content;
        if (!Array.isArray(content)) return [];

        const events: ProviderEvent[] = [];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            events.push({ type: 'text_delta', text: block.text });
          } else if (block.type === 'tool_use') {
            events.push({
              type: 'tool_use',
              toolCallId: block.id ?? '',
              toolName: block.name ?? '',
              input: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
            });
          } else if (block.type === 'thinking' && block.thinking) {
            events.push({ type: 'thinking', text: block.thinking });
          }
        }
        return events;
      }

      // result 이벤트: usage + done
      if (data.type === 'result') {
        const events: ProviderEvent[] = [];
        const u = data.usage;
        if (u) {
          events.push({
            type: 'usage',
            usage: {
              promptTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
              completionTokens: u.output_tokens ?? 0,
              totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
            },
          });
        }

        const finishReason = data.stop_reason === 'max_tokens' ? 'length' as const
          : data.stop_reason === 'tool_use' ? 'tool_use' as const
          : 'stop' as const;
        events.push({ type: 'done', finishReason });
        return events;
      }

      return [];
    } catch {
      return [];
    }
  }
}

// thread_id 형식 검증 — codex는 UUID(8-4-4-4-12) 또는 그 변형(접두/접미) 사용.
// 보안: stdout에서 추출한 임의 문자열을 SessionManager 키로 쓰기 전 형식 검증으로 인젝션 방어.
function isLikelyUuid(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
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

  parseEvents(line: string): ProviderEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    try {
      const data = JSON.parse(trimmed);

      // thread.started: 첫 라인에서 thread_id 노출. CodexProvider wrapper가 가로채 SessionManager.set 수행.
      // thread_id / threadId / thread.id 3가지 키 경로 모두 처리 (codex 버전별 차이 대응).
      if (data.type === 'thread.started') {
        const tid = typeof data.thread_id === 'string' ? data.thread_id
          : typeof data.threadId === 'string' ? data.threadId
          : (data.thread && typeof data.thread.id === 'string') ? data.thread.id
          : null;
        if (tid && isLikelyUuid(tid)) {
          return [{ type: 'thread_started', threadId: tid }];
        }
        return [];
      }

      if (data.type === 'item.completed' && data.item) {
        if (data.item.type === 'error') {
          return [{ type: 'error', error: data.item.message ?? 'Codex item error' }];
        }
        const text = data.item.text ?? '';
        if (text) return [{ type: 'text_delta', text }];
        return [];
      }

      if (data.type === 'turn.completed') {
        const events: ProviderEvent[] = [];
        const u = data.usage;
        if (u) {
          events.push({
            type: 'usage',
            usage: {
              promptTokens: u.input_tokens ?? 0,
              completionTokens: u.output_tokens ?? 0,
              totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
            },
          });
        }
        events.push({ type: 'done' });
        return events;
      }

      if (data.type === 'turn.failed' || data.type === 'error') {
        return [{ type: 'error', error: data.error?.message ?? data.message ?? 'Codex error' }];
      }

      return [];
    } catch {
      if (trimmed) return [{ type: 'text_delta', text: trimmed }];
      return [];
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

  parseEvents(line: string): ProviderEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    try {
      const data = JSON.parse(trimmed);

      if (data.type === 'message' && data.role === 'assistant' && data.delta === true) {
        const content = data.content ?? '';
        if (content) return [{ type: 'text_delta', text: content }];
        return [];
      }

      if (data.type === 'result') {
        const events: ProviderEvent[] = [];
        const stats = data.stats;
        if (stats) {
          events.push({
            type: 'usage',
            usage: {
              promptTokens: stats.input_tokens ?? 0,
              completionTokens: stats.output_tokens ?? 0,
              totalTokens: stats.total_tokens ?? ((stats.input_tokens ?? 0) + (stats.output_tokens ?? 0)),
            },
          });
        }
        events.push({ type: 'done' });
        return events;
      }

      return [];
    } catch {
      return [];
    }
  }
}

// --- SSE 변환 ---

// ProviderEvent 전용 타입만 존재하는지 확인 (StreamChunk과 겹치지 않는 type)
const PROVIDER_EVENT_ONLY_TYPES = new Set(['text_delta', 'tool_use', 'thinking', 'usage']);

export interface FormatAsSseOptions {
  // true면 thinking 이벤트를 delta.reasoning_content SSE로 직렬화. false/생략이면 thinking 무시.
  includeReasoning?: boolean;
}

// StreamChunk 또는 ProviderEvent를 OpenAI SSE 형식으로 변환
export function formatAsSSE(
  event: ProviderEvent | StreamChunk,
  requestId: string,
  model: string,
  options: FormatAsSseOptions = {},
): string | null {
  // ProviderEvent 전용 타입이면 ProviderEvent 경로
  if (PROVIDER_EVENT_ONLY_TYPES.has(event.type)) {
    return formatProviderEventAsSSE(event as ProviderEvent, requestId, model, options);
  }

  // done/error 타입은 ProviderEvent와 StreamChunk 공통이므로 finishReason 필드로 판별
  if ('finishReason' in event) {
    return formatProviderEventAsSSE(event as ProviderEvent, requestId, model, options);
  }

  // 레거시 StreamChunk 처리
  const chunk = event as StreamChunk;

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

// ProviderEvent → OpenAI SSE 변환
function formatProviderEventAsSSE(
  event: ProviderEvent,
  requestId: string,
  model: string,
  options: FormatAsSseOptions = {},
): string | null {
  const makeChunk = (delta: Record<string, unknown>, finishReason: string | null = null): string => {
    const data: ChatCompletionChunk = {
      id: requestId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: delta as ChatCompletionChunk['choices'][0]['delta'],
        finish_reason: finishReason as ChatCompletionChunk['choices'][0]['finish_reason'],
      }],
    };
    return `data: ${JSON.stringify(data)}\n\n`;
  };

  switch (event.type) {
    case 'text_delta':
      return makeChunk({ content: event.text });

    case 'tool_use':
      return makeChunk({
        tool_calls: [{
          index: event.index ?? 0,
          id: event.isPartial ? undefined : event.toolCallId,
          type: event.isPartial ? undefined : 'function',
          function: {
            name: event.isPartial ? undefined : event.toolName,
            arguments: event.input,
          },
        }],
      });

    case 'thinking':
      // include_reasoning=true일 때만 delta.reasoning_content로 직렬화 (vLLM/sglang 호환 비표준 확장).
      // 일반 OpenAI SDK는 모르는 필드 무시하므로 안전.
      if (!options.includeReasoning) return null;
      return makeChunk({ reasoning_content: event.text });

    case 'usage':
      // OpenAI에서는 stream_options.include_usage로 처리 → 무시
      return null;

    case 'error':
      return null;

    case 'done': {
      // tool_use → OpenAI 'tool_calls' finish_reason (에이전트가 도구 실행 여부 판단에 사용).
      const finishReason = event.finishReason === 'tool_use' ? 'tool_calls'
        : event.finishReason === 'length' ? 'length'
        : 'stop';
      return makeChunk({}, finishReason) + 'data: [DONE]\n\n';
    }

    default:
      return null;
  }
}

export function createRequestId(): string {
  return `chatcmpl-proxy-${nanoid(24)}`;
}

// 플러그인용 기본 파서: 각 라인을 그대로 텍스트 delta로 변환
export class PlainTextParser implements StreamParser {
  parse(line: string): StreamChunk | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    return { type: 'delta', content: trimmed };
  }

  parseEvents(line: string): ProviderEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    return [{ type: 'text_delta', text: trimmed }];
  }
}

// 파서 레지스트리: 프로바이더 이름 → 파서 팩토리
const parserRegistry = new Map<string, () => StreamParser>();

// 빌트인 파서 등록
parserRegistry.set('claude', () => new ClaudeStreamParser());
parserRegistry.set('codex', () => new CodexStreamParser());
parserRegistry.set('gemini', () => new GeminiStreamParser());
// agy 1.0.0: plain text 출력 — line-based parser는 사실상 사용되지 않지만
// (AgyProvider.execute/executeStream이 직접 처리) registry 일관성을 위해 PlainTextParser 등록.
parserRegistry.set('agy', () => new PlainTextParser());
// grok: plain text 출력 — GrokProvider.execute/executeStream이 직접 처리.
// registry 일관성을 위해 PlainTextParser 등록.
parserRegistry.set('grok', () => new PlainTextParser());

// 플러그인에서 커스텀 파서를 등록할 때 사용
export function registerParser(provider: string, factory: () => StreamParser): void {
  parserRegistry.set(provider, factory);
}

export function getParserForProvider(provider: string): StreamParser {
  const factory = parserRegistry.get(provider);
  if (factory) return factory();
  // 등록되지 않은 프로바이더는 PlainText 파서로 폴백
  return new PlainTextParser();
}
