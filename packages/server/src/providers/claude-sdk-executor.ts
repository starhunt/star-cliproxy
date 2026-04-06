// Claude Agent SDK 실행기
// CLI 대신 @anthropic-ai/claude-agent-sdk의 query()를 사용하여 Claude Code 실행
// lazy import로 SDK 미설치 시에도 서버 기동 가능

import type {
  ExecuteOptions,
  ExecuteResult,
  ProviderEvent,
  TokenUsage,
  ClaudeSdkOptions,
} from '@star-cliproxy/shared';
import { convertMessages } from '../utils/message-converter.js';
import type { ClaudeSdkSessionManager } from './claude-sdk-session-manager.js';

// SDK 타입 (lazy import이므로 여기서는 인터페이스로 정의)
interface SdkQueryOptions {
  abortController?: AbortController;
  model?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  maxTurns?: number;
  maxBudgetUsd?: number;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  persistSession?: boolean;
  resume?: string;
  includePartialMessages?: boolean;
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code' };
  settingSources?: string[];
  pathToClaudeCodeExecutable?: string;
}

export interface SdkExecutorConfig {
  model: string;
  sdkOptions: ClaudeSdkOptions;
  workingDir: string;
  timeoutMs: number;
  cleanEnv: Record<string, string | undefined>;
  cliPath: string;
  // 세션 관련
  sessionManager?: ClaudeSdkSessionManager;
  clientKey?: string;  // 세션 재사용용 클라이언트 식별자
  // 스트리밍에서 세션 메타를 전달하기 위한 콜백
  onSdkMeta?: (meta: SdkMeta) => void;
}

export interface SdkMeta {
  sessionId: string | null;
  sessionReused: boolean;
  retried: boolean;
}

// lazy import: SDK 미설치 시에도 서버 기동 가능
let sdkModule: { query: (params: { prompt: string; options?: SdkQueryOptions }) => AsyncGenerator<unknown, void> } | null = null;

async function getSDK() {
  if (sdkModule) return sdkModule;
  try {
    sdkModule = await import('@anthropic-ai/claude-agent-sdk') as unknown as typeof sdkModule;
    return sdkModule!;
  } catch {
    throw new Error(
      'Claude Agent SDK가 설치되지 않았습니다. 설치: npm install @anthropic-ai/claude-agent-sdk'
    );
  }
}

// SDK query 옵션 빌드
function buildQueryOptions(
  options: ExecuteOptions,
  config: SdkExecutorConfig,
  resumeSessionId?: string,
): { prompt: string; options: SdkQueryOptions } {
  const { systemPrompt, userPrompt } = convertMessages(options.messages);
  const { sdkOptions } = config;

  const abortController = new AbortController();

  // 외부 signal과 타임아웃을 결합
  if (options.signal) {
    options.signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }
  const timeoutId = setTimeout(() => abortController.abort(), config.timeoutMs);
  // abort 시 타이머 정리
  abortController.signal.addEventListener('abort', () => clearTimeout(timeoutId), { once: true });

  const permissionMode = sdkOptions.permission_mode ?? 'bypassPermissions';

  const queryOptions: SdkQueryOptions = {
    abortController,
    model: config.model,
    cwd: config.workingDir,
    env: {
      ...config.cleanEnv,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'star-cliproxy/1.0.0',
    },
    maxTurns: sdkOptions.max_turns ?? 50,
    maxBudgetUsd: sdkOptions.max_budget_usd,
    permissionMode,
    allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
    persistSession: sdkOptions.persist_session ?? false,
    settingSources: [],  // SDK 격리 모드: 파일시스템 설정 미로드
    pathToClaudeCodeExecutable: config.cliPath,
    includePartialMessages: options.stream,
  };

  if (sdkOptions.allowed_tools?.length) {
    queryOptions.allowedTools = sdkOptions.allowed_tools;
  }
  if (sdkOptions.disallowed_tools?.length) {
    queryOptions.disallowedTools = sdkOptions.disallowed_tools;
  }

  // 세션 재사용
  if (resumeSessionId) {
    queryOptions.resume = resumeSessionId;
  }

  // 시스템 프롬프트
  if (systemPrompt) {
    queryOptions.systemPrompt = systemPrompt;
  }

  return { prompt: userPrompt, options: queryOptions };
}

// SDK 메시지에서 assistant 텍스트 추출
function extractAssistantText(msg: Record<string, unknown>): string | null {
  if (msg.type !== 'assistant') return null;

  const message = msg.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const content = message.content;
  if (!Array.isArray(content)) return null;

  const texts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === 'string') {
        texts.push(text);
      }
    }
  }

  return texts.length > 0 ? texts.join('') : null;
}

// SDK 메시지에서 스트리밍 delta 텍스트 추출 (partial message)
function extractStreamDelta(msg: Record<string, unknown>): string | null {
  if (msg.type !== 'stream_event') return null;

  const event = msg.event as Record<string, unknown> | undefined;
  if (!event) return null;

  // content_block_delta 이벤트에서 텍스트 추출
  if (event.type === 'content_block_delta') {
    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return delta.text;
    }
  }

  return null;
}

// SDK result 메시지에서 usage 추출
function extractUsage(msg: Record<string, unknown>): TokenUsage | null {
  if (msg.type !== 'result') return null;

  const usage = msg.usage as Record<string, unknown> | undefined;
  if (!usage) return null;

  const inputTokens = (usage.input_tokens as number) ?? 0;
  const outputTokens = (usage.output_tokens as number) ?? 0;
  const cacheRead = (usage.cache_read_input_tokens as number) ?? 0;
  const cacheCreate = (usage.cache_creation_input_tokens as number) ?? 0;

  return {
    promptTokens: inputTokens + cacheRead + cacheCreate,
    completionTokens: outputTokens,
    totalTokens: inputTokens + outputTokens + cacheRead + cacheCreate,
  };
}

// SDK 메시지에서 session_id 추출 (모든 메시지에 포함)
function extractSessionId(msg: Record<string, unknown>): string | null {
  return typeof msg.session_id === 'string' ? msg.session_id : null;
}

// SDK 실행 결과에 세션 메타데이터 포함
export interface SdkExecuteResult extends ExecuteResult {
  sdkMeta: {
    sessionId: string | null;
    sessionReused: boolean;
    retried: boolean;
  };
}

// Non-streaming 실행
export async function executeSdk(
  options: ExecuteOptions,
  config: SdkExecutorConfig,
): Promise<SdkExecuteResult> {
  const sdk = await getSDK();

  // 세션 재사용 시도
  const sessionReuse = config.sdkOptions.enable_session_reuse !== false;
  const existingSession = sessionReuse && config.sessionManager && config.clientKey
    ? config.sessionManager.get(config.clientKey, config.model)
    : null;

  const queryParams = buildQueryOptions(options, config, existingSession?.sessionId);

  let content = '';
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let finishReason: ExecuteResult['finishReason'] = 'stop';
  let capturedSessionId: string | null = null;
  let isError = false;
  let retried = false;

  try {
    for await (const rawMsg of sdk.query(queryParams)) {
      const msg = rawMsg as Record<string, unknown>;

      // session_id 캡처
      if (!capturedSessionId) {
        capturedSessionId = extractSessionId(msg);
      }

      // assistant 메시지에서 텍스트 추출
      const text = extractAssistantText(msg);
      if (text !== null) {
        content = text; // 마지막 assistant 메시지의 전체 텍스트 사용
      }

      // result 이벤트에서 usage 추출
      if (msg.type === 'result') {
        const extractedUsage = extractUsage(msg);
        if (extractedUsage) {
          usage = extractedUsage;
        }

        // result 텍스트 (assistant 메시지가 없는 경우 폴백)
        if (!content && typeof msg.result === 'string') {
          content = msg.result;
        }

        // 에러 결과 처리
        if (msg.is_error === true) {
          isError = true;
          const subtype = msg.subtype as string;
          if (subtype === 'error_max_turns' || subtype === 'error_max_budget_usd') {
            finishReason = 'length';
          } else {
            finishReason = 'error';
          }
        }

        // stop_reason 매핑
        if (msg.stop_reason === 'max_tokens') {
          finishReason = 'length';
        }
      }
    }

    // 세션 ID 저장 (재사용 활성화 시)
    if (capturedSessionId && sessionReuse && config.sessionManager && config.clientKey) {
      config.sessionManager.set(config.clientKey, capturedSessionId, config.model);
    }
  } catch (err) {
    // 세션 관련 에러 시 세션 무효화 후 재시도 (1회)
    if (existingSession && config.sessionManager && config.clientKey) {
      config.sessionManager.invalidate(config.clientKey);

      // cold-start fallback: 세션 없이 재시도
      retried = true;
      const retryParams = buildQueryOptions(options, config);
      content = '';
      capturedSessionId = null;

      try {
        for await (const rawMsg of sdk.query(retryParams)) {
          const msg = rawMsg as Record<string, unknown>;

          if (!capturedSessionId) {
            capturedSessionId = extractSessionId(msg);
          }

          const text = extractAssistantText(msg);
          if (text !== null) content = text;

          if (msg.type === 'result') {
            const extractedUsage = extractUsage(msg);
            if (extractedUsage) usage = extractedUsage;
            if (!content && typeof msg.result === 'string') content = msg.result;
          }
        }

        // 재시도 성공 시 새 세션 저장
        if (capturedSessionId && config.sessionManager && config.clientKey) {
          config.sessionManager.set(config.clientKey, capturedSessionId, config.model);
        }
      } catch (retryErr) {
        throw new Error(`Claude SDK 실행 실패 (재시도 포함): ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
      }
    } else {
      throw new Error(`Claude SDK 실행 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    content,
    usage,
    finishReason: isError ? finishReason : 'stop',
    sdkMeta: {
      sessionId: capturedSessionId,
      sessionReused: !!existingSession && !retried,
      retried,
    },
  };
}

// SDK stream_event에서 thinking delta 추출
function extractThinkingDelta(msg: Record<string, unknown>): string | null {
  if (msg.type !== 'stream_event') return null;
  const event = msg.event as Record<string, unknown> | undefined;
  if (!event || event.type !== 'content_block_delta') return null;
  const delta = event.delta as Record<string, unknown> | undefined;
  if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
    return delta.thinking;
  }
  return null;
}

// SDK 메시지를 ProviderEvent[]로 변환
function sdkMsgToEvents(msg: Record<string, unknown>, isStreamMode: boolean): ProviderEvent[] {
  const events: ProviderEvent[] = [];

  // stream_event: 실시간 delta (text 또는 thinking)
  const textDelta = extractStreamDelta(msg);
  if (textDelta) {
    events.push({ type: 'text_delta', text: textDelta });
    return events;
  }

  const thinkingDelta = extractThinkingDelta(msg);
  if (thinkingDelta) {
    events.push({ type: 'thinking', text: thinkingDelta });
    return events;
  }

  // assistant 메시지: 전체 텍스트 (stream_event 미사용 시 폴백)
  if (msg.type === 'assistant' && !isStreamMode) {
    const text = extractAssistantText(msg);
    if (text) {
      events.push({ type: 'text_delta', text });
    }
    return events;
  }

  // result 이벤트: 완료
  if (msg.type === 'result') {
    if (msg.is_error === true) {
      const errors = msg.errors as string[] | undefined;
      events.push({ type: 'error', error: errors?.join('; ') ?? 'SDK execution error' });
    }

    const usage = extractUsage(msg);
    if (usage) {
      events.push({ type: 'usage', usage });
    }

    const finishReason = msg.stop_reason === 'max_tokens' ? 'length' as const
      : msg.is_error ? 'error' as const
      : 'stop' as const;
    events.push({ type: 'done', finishReason });
    return events;
  }

  return events;
}

// Streaming 실행
export async function* executeStreamSdk(
  options: ExecuteOptions,
  config: SdkExecutorConfig,
): AsyncGenerator<ProviderEvent, void> {
  const sdk = await getSDK();

  // 세션 재사용 시도
  const sessionReuse = config.sdkOptions.enable_session_reuse !== false;
  const existingSession = sessionReuse && config.sessionManager && config.clientKey
    ? config.sessionManager.get(config.clientKey, config.model)
    : null;

  const queryParams = buildQueryOptions(options, config, existingSession?.sessionId);
  let capturedSessionId: string | null = null;

  try {
    for await (const rawMsg of sdk.query(queryParams)) {
      const msg = rawMsg as Record<string, unknown>;

      if (!capturedSessionId) {
        capturedSessionId = extractSessionId(msg);
      }

      const events = sdkMsgToEvents(msg, options.stream);
      for (const event of events) {
        yield event;
        if (event.type === 'done') break;
      }
      if (events.some(e => e.type === 'done')) break;
    }

    // 세션 ID 저장 + 메타 콜백
    if (capturedSessionId && sessionReuse && config.sessionManager && config.clientKey) {
      config.sessionManager.set(config.clientKey, capturedSessionId, config.model);
    }
    config.onSdkMeta?.({
      sessionId: capturedSessionId,
      sessionReused: !!existingSession,
      retried: false,
    });
  } catch (err) {
    // 세션 관련 에러 시 세션 무효화 후 재시도 (1회)
    if (existingSession && config.sessionManager && config.clientKey) {
      config.sessionManager.invalidate(config.clientKey);

      const retryParams = buildQueryOptions(options, config);
      capturedSessionId = null;

      try {
        for await (const rawMsg of sdk.query(retryParams)) {
          const msg = rawMsg as Record<string, unknown>;

          if (!capturedSessionId) {
            capturedSessionId = extractSessionId(msg);
          }

          const events = sdkMsgToEvents(msg, options.stream);
          for (const event of events) {
            yield event;
            if (event.type === 'done') break;
          }
          if (events.some(e => e.type === 'done')) break;
        }

        if (capturedSessionId && config.sessionManager && config.clientKey) {
          config.sessionManager.set(config.clientKey, capturedSessionId, config.model);
        }
        config.onSdkMeta?.({
          sessionId: capturedSessionId,
          sessionReused: false,
          retried: true,
        });
      } catch (retryErr) {
        yield { type: 'error', error: `Claude SDK 실행 실패 (재시도 포함): ${retryErr instanceof Error ? retryErr.message : String(retryErr)}` };
        yield { type: 'done' };
      }
    } else {
      yield { type: 'error', error: `Claude SDK 실행 실패: ${err instanceof Error ? err.message : String(err)}` };
      yield { type: 'done' };
    }
  }
}
