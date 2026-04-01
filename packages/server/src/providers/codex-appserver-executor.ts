// Codex App Server 실행기
// JSON-RPC 프로세스를 통해 요청 전송 및 응답 수신
// thread/start, thread/resume, turn/start + 알림 기반 스트리밍
// 스키마: codex app-server generate-ts 기준 (v2)

import type {
  ExecuteOptions,
  ExecuteResult,
  StreamChunk,
  CodexAppServerOptions,
} from '@star-cliproxy/shared';
import type { CodexAppServerProcess } from './codex-appserver-process.js';
import type { CodexAppServerSessionManager } from './codex-appserver-session-manager.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';

// --- 설정 인터페이스 ---

export interface AppServerExecutorConfig {
  model: string;
  options: CodexAppServerOptions;
  process: CodexAppServerProcess;
  sessionManager?: CodexAppServerSessionManager;
  clientKey?: string;
  timeoutMs: number;
  // 스트리밍에서 메타를 전달하기 위한 콜백
  onAppServerMeta?: (meta: AppServerMeta) => void;
}

export interface AppServerMeta {
  threadId: string | null;
  threadReused: boolean;
  retried: boolean;
}

// 실행 결과에 메타데이터 포함
export interface AppServerExecuteResult extends ExecuteResult {
  appServerMeta: AppServerMeta;
}

// --- Codex App Server JSON-RPC 타입 (generate-ts 스키마 기반) ---

interface ThreadStartResponse {
  thread?: { id?: string; [key: string]: unknown };
  threadId?: string;
  thread_id?: string;
  [key: string]: unknown;
}

interface ThreadResumeResponse {
  thread?: { id?: string; [key: string]: unknown };
  threadId?: string;
  thread_id?: string;
  [key: string]: unknown;
}

interface ThreadStartedParams {
  thread?: { id?: string; [key: string]: unknown };
  threadId?: string;
  thread_id?: string;
  [key: string]: unknown;
}

// item/agentMessage/delta 알림
interface AgentMessageDeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

// item/completed 알림 — item은 ThreadItem union
interface ItemCompletedParams {
  item: {
    type: string;
    id: string;
    text?: string;          // agentMessage 타입일 때
    [key: string]: unknown;
  };
  threadId: string;
  turnId: string;
}

// turn/completed 알림
interface TurnCompletedParams {
  threadId: string;
  turn: {
    id: string;
    status: string;
    error: { message: string } | null;
  };
}

// thread/tokenUsage/updated 알림
interface TokenUsageUpdatedParams {
  threadId: string;
  turnId: string;
  tokenUsage: {
    total: TokenUsageBreakdown;
    last: TokenUsageBreakdown;
  };
}

interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

// --- 콜백→AsyncGenerator 브릿지 채널 ---

interface ChannelItem<T> {
  value?: T;
  done?: boolean;
  error?: Error;
}

class AsyncChannel<T> {
  private queue: ChannelItem<T>[] = [];
  private waiting: ((item: ChannelItem<T>) => void) | null = null;

  push(value: T): void {
    const item: ChannelItem<T> = { value };
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(item);
    } else {
      this.queue.push(item);
    }
  }

  end(): void {
    const item: ChannelItem<T> = { done: true };
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(item);
    } else {
      this.queue.push(item);
    }
  }

  fail(error: Error): void {
    const item: ChannelItem<T> = { error };
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(item);
    } else {
      this.queue.push(item);
    }
  }

  async next(): Promise<ChannelItem<T>> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    return new Promise<ChannelItem<T>>((resolve) => {
      this.waiting = resolve;
    });
  }
}

// --- 스레드 생성/재사용 ---

function extractThreadId(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as {
    thread?: { id?: unknown };
    threadId?: unknown;
    thread_id?: unknown;
  };

  if (typeof candidate.thread?.id === 'string' && candidate.thread.id.trim()) {
    return candidate.thread.id;
  }

  if (typeof candidate.threadId === 'string' && candidate.threadId.trim()) {
    return candidate.threadId;
  }

  if (typeof candidate.thread_id === 'string' && candidate.thread_id.trim()) {
    return candidate.thread_id;
  }

  return null;
}

function waitForThreadStartedNotification(
  proc: CodexAppServerProcess,
  timeoutMs: number,
): { promise: Promise<string | null>; cleanup: () => void } {
  let settled = false;
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    unsubscribe();
  };

  const promise = new Promise<string | null>((resolve) => {
    const finish = (threadId: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(threadId);
    };

    unsubscribe = proc.onNotification('thread/started', (params) => {
      finish(extractThreadId(params as ThreadStartedParams));
    });

    // Some app-server builds emit the authoritative thread id on thread/started.
    // If we miss it and keep `undefined`, JSON.stringify drops `threadId` from turn/start,
    // which surfaces as the misleading server error: "missing field threadId".
    timer = setTimeout(() => {
      finish(null);
    }, Math.min(timeoutMs, 1000));
  });

  return { promise, cleanup };
}

function requireThreadIdForTurn(threadId: string | null | undefined, source: string): string {
  if (typeof threadId === 'string' && threadId.trim()) {
    return threadId;
  }

  throw new Error(
    `${source} did not return a usable threadId. Refusing to send turn/start because JSON.stringify would omit an undefined threadId and the app-server would reject the request as "missing field threadId".`,
  );
}

async function getOrCreateThread(
  proc: CodexAppServerProcess,
  existingThreadId: string | null,
  timeoutMs: number,
): Promise<{ threadId: string; reused: boolean }> {
  if (existingThreadId) {
    // 기존 스레드 재사용 시도
    const result = await proc.request<ThreadResumeResponse>(
      'thread/resume',
      {
        threadId: existingThreadId,
        persistExtendedHistory: false,
      },
      timeoutMs,
    );
    return {
      threadId: requireThreadIdForTurn(extractThreadId(result) ?? existingThreadId, 'thread/resume'),
      reused: true,
    };
  }

  // 새 스레드 생성
  const threadStarted = waitForThreadStartedNotification(proc, timeoutMs);
  try {
    const result = await proc.request<ThreadStartResponse>(
      'thread/start',
      {
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      },
      timeoutMs,
    );

    return {
      threadId: requireThreadIdForTurn(
        extractThreadId(result) ?? await threadStarted.promise,
        'thread/start',
      ),
      reused: false,
    };
  } finally {
    threadStarted.cleanup();
  }
}

// --- UserInput 빌드 ---

function buildUserInput(prompt: string): Array<{ type: 'text'; text: string; text_elements: never[] }> {
  return [{ type: 'text', text: prompt, text_elements: [] }];
}

// --- 디버그 정보 빌드 ---

function buildDebugArgs(
  model: string,
  threadId: string | null,
  threadReused: boolean,
): string[] {
  return [
    'app-server',
    '--model', model,
    threadReused ? '(thread-reused)' : '(new-thread)',
    `thread:${threadId ?? 'none'}`,
  ];
}

// --- Non-streaming 실행 ---

export async function executeAppServer(
  options: ExecuteOptions,
  config: AppServerExecutorConfig,
): Promise<AppServerExecuteResult> {
  const { process: proc, model, sessionManager, clientKey, timeoutMs } = config;

  if (!proc.isAlive()) {
    throw new Error('Codex App Server 프로세스가 실행 중이 아닙니다');
  }

  // 메시지를 단일 프롬프트로 변환
  const prompt = convertMessagesToSinglePrompt(options.messages);

  // 세션 재사용 시도
  const existingThread = sessionManager && clientKey
    ? sessionManager.get(clientKey, model)
    : null;

  let threadId: string | null = null;
  let threadReused = false;
  let retried = false;
  let content = '';
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const finishReason: ExecuteResult['finishReason'] = 'stop';

  try {
    const result = await executeTurn(proc, prompt, existingThread?.threadId ?? null, timeoutMs, options.signal);
    threadId = result.threadId;
    threadReused = result.threadReused;
    content = result.content;
    usage = result.usage;

    // 스레드 ID 저장
    if (threadId && sessionManager && clientKey) {
      sessionManager.set(clientKey, threadId, model);
    }

    // 정상 완료 시 재시작 카운터 초기화
    proc.resetRestartCount();
  } catch (err) {
    // 스레드 관련 에러 시 무효화 후 새 스레드로 재시도 (1회)
    if (existingThread && sessionManager && clientKey) {
      sessionManager.invalidate(clientKey);
      retried = true;

      try {
        const retryResult = await executeTurn(proc, prompt, null, timeoutMs, options.signal);
        threadId = retryResult.threadId;
        threadReused = false;
        content = retryResult.content;
        usage = retryResult.usage;

        // 재시도 성공 시 새 스레드 저장
        if (threadId && sessionManager && clientKey) {
          sessionManager.set(clientKey, threadId, model);
        }
        proc.resetRestartCount();
      } catch (retryErr) {
        throw new Error(
          `Codex App Server 실행 실패 (재시도 포함): ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
        );
      }
    } else {
      throw new Error(
        `Codex App Server 실행 실패: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 디버그 콜백
  options.onDebug?.({
    cliArgs: buildDebugArgs(model, threadId, threadReused && !retried),
  });

  return {
    content,
    usage,
    finishReason,
    appServerMeta: {
      threadId,
      threadReused: threadReused && !retried,
      retried,
    },
  };
}

// Non-streaming turn 실행 (알림 수집 후 결과 반환)
async function executeTurn(
  proc: CodexAppServerProcess,
  prompt: string,
  existingThreadId: string | null,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{
  threadId: string;
  threadReused: boolean;
  content: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}> {
  // 스레드 생성/재사용
  const { threadId: rawThreadId, reused } = await getOrCreateThread(proc, existingThreadId, timeoutMs);
  const threadId = requireThreadIdForTurn(rawThreadId, 'getOrCreateThread');

  // 결과 수집용 변수
  let content = '';
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const deltaChunks: string[] = [];

  // turn/completed 대기용 Promise
  const turnCompleted = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`turn/completed 타임아웃 (${timeoutMs}ms)`));
    }, timeoutMs);

    // abort signal 연결
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('요청이 취소되었습니다'));
      }, { once: true });
    }

    // 알림 핸들러 등록
    const cleanups: (() => void)[] = [];

    // item/agentMessage/delta: 텍스트 청크 수집
    cleanups.push(proc.onNotification('item/agentMessage/delta', (params) => {
      const p = params as AgentMessageDeltaParams;
      if (p.threadId === threadId) {
        deltaChunks.push(p.delta);
      }
    }));

    // item/completed: agentMessage의 전체 텍스트 추출
    cleanups.push(proc.onNotification('item/completed', (params) => {
      const p = params as ItemCompletedParams;
      if (p.threadId === threadId && p.item.type === 'agentMessage' && p.item.text) {
        content = p.item.text;
      }
    }));

    // thread/tokenUsage/updated: usage 추출
    cleanups.push(proc.onNotification('thread/tokenUsage/updated', (params) => {
      const p = params as TokenUsageUpdatedParams;
      if (p.threadId === threadId) {
        const last = p.tokenUsage.last;
        usage = {
          promptTokens: last.inputTokens,
          completionTokens: last.outputTokens,
          totalTokens: last.totalTokens,
        };
      }
    }));

    // turn/completed: 종료 신호
    cleanups.push(proc.onNotification('turn/completed', (params) => {
      const p = params as TurnCompletedParams;
      if (p.threadId === threadId) {
        clearTimeout(timer);
        // 핸들러 정리
        for (const cleanup of cleanups) cleanup();
        resolve();
      }
    }));
  });

  // turn/start 전송 (v2 스키마: input은 UserInput 배열)
  await proc.request('turn/start', {
    threadId,
    input: buildUserInput(prompt),
  }, timeoutMs);

  // turn/completed 대기
  await turnCompleted;

  // content 결정: item/completed의 text 또는 delta 조합
  if (!content && deltaChunks.length > 0) {
    content = deltaChunks.join('');
  }

  return { threadId, threadReused: reused, content, usage };
}

// --- Streaming 실행 ---

export async function* executeStreamAppServer(
  options: ExecuteOptions,
  config: AppServerExecutorConfig,
): AsyncGenerator<StreamChunk, void> {
  const { process: proc, model, sessionManager, clientKey, timeoutMs } = config;

  if (!proc.isAlive()) {
    yield { type: 'error', error: 'Codex App Server 프로세스가 실행 중이 아닙니다' };
    yield { type: 'done' };
    return;
  }

  // 메시지를 단일 프롬프트로 변환
  const prompt = convertMessagesToSinglePrompt(options.messages);

  // 세션 재사용 시도
  const existingThread = sessionManager && clientKey
    ? sessionManager.get(clientKey, model)
    : null;

  try {
    yield* executeStreamTurn(
      proc, prompt, existingThread?.threadId ?? null, timeoutMs, model, options, config,
    );
  } catch (err) {
    // 스레드 관련 에러 시 무효화 후 새 스레드로 재시도 (1회)
    if (existingThread && sessionManager && clientKey) {
      sessionManager.invalidate(clientKey);

      try {
        yield* executeStreamTurn(
          proc, prompt, null, timeoutMs, model, options, config,
        );

        config.onAppServerMeta?.({
          threadId: null,
          threadReused: false,
          retried: true,
        });
      } catch (retryErr) {
        yield {
          type: 'error',
          error: `Codex App Server 실행 실패 (재시도 포함): ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
        };
        yield { type: 'done' };
      }
    } else {
      yield {
        type: 'error',
        error: `Codex App Server 실행 실패: ${err instanceof Error ? err.message : String(err)}`,
      };
      yield { type: 'done' };
    }
  }
}

// Streaming turn 실행 (알림을 AsyncGenerator로 브릿지)
async function* executeStreamTurn(
  proc: CodexAppServerProcess,
  prompt: string,
  existingThreadId: string | null,
  timeoutMs: number,
  model: string,
  options: ExecuteOptions,
  config: AppServerExecutorConfig,
): AsyncGenerator<StreamChunk, void> {
  // 스레드 생성/재사용
  const { threadId: rawThreadId, reused } = await getOrCreateThread(proc, existingThreadId, timeoutMs);
  const threadId = requireThreadIdForTurn(rawThreadId, 'getOrCreateThread');

  // 콜백→AsyncGenerator 브릿지 채널
  const channel = new AsyncChannel<StreamChunk>();
  const cleanups: (() => void)[] = [];

  // 타임아웃 타이머
  const timer = setTimeout(() => {
    channel.fail(new Error(`turn/completed 타임아웃 (${timeoutMs}ms)`));
  }, timeoutMs);

  // abort signal 연결
  if (options.signal) {
    options.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      channel.fail(new Error('요청이 취소되었습니다'));
    }, { once: true });
  }

  // 알림 핸들러 등록

  // item/agentMessage/delta: 텍스트 청크를 채널로 전달
  cleanups.push(proc.onNotification('item/agentMessage/delta', (params) => {
    const p = params as AgentMessageDeltaParams;
    if (p.threadId === threadId) {
      channel.push({ type: 'delta', content: p.delta });
    }
  }));

  // thread/tokenUsage/updated: usage 수집
  let finalUsage: StreamChunk['usage'] | undefined;
  cleanups.push(proc.onNotification('thread/tokenUsage/updated', (params) => {
    const p = params as TokenUsageUpdatedParams;
    if (p.threadId === threadId) {
      const last = p.tokenUsage.last;
      finalUsage = {
        promptTokens: last.inputTokens,
        completionTokens: last.outputTokens,
        totalTokens: last.totalTokens,
      };
    }
  }));

  // turn/completed: 완료 신호
  cleanups.push(proc.onNotification('turn/completed', (params) => {
    const p = params as TurnCompletedParams;
    if (p.threadId === threadId) {
      clearTimeout(timer);
      channel.push({ type: 'done', usage: finalUsage });
      channel.end();
    }
  }));

  // turn/start 전송 (v2 스키마: input은 UserInput 배열)
  try {
    await proc.request('turn/start', {
      threadId,
      input: buildUserInput(prompt),
    }, timeoutMs);
  } catch (err) {
    clearTimeout(timer);
    for (const cleanup of cleanups) cleanup();
    throw err;
  }

  // 채널에서 청크를 읽어 yield
  try {
    while (true) {
      const item = await channel.next();

      if (item.error) {
        throw item.error;
      }

      if (item.done) {
        break;
      }

      if (item.value) {
        yield item.value;

        // done 청크이면 루프 종료
        if (item.value.type === 'done') {
          break;
        }
      }
    }

    // 스레드 ID 저장
    if (threadId && config.sessionManager && config.clientKey) {
      config.sessionManager.set(config.clientKey, threadId, model);
    }

    // 정상 완료 시 재시작 카운터 초기화
    proc.resetRestartCount();

    // 디버그 콜백
    options.onDebug?.({
      cliArgs: buildDebugArgs(model, threadId, reused),
    });

    // 메타 콜백
    config.onAppServerMeta?.({
      threadId,
      threadReused: reused,
      retried: false,
    });
  } finally {
    // 핸들러 정리
    clearTimeout(timer);
    for (const cleanup of cleanups) cleanup();
  }
}
