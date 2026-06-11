// codex app-server 동시성 테스트 (#24)
// 같은 clientKey+model 동시 요청 시 단일 프로세스 공유 + threadId-only 알림 필터로
// 응답 텍스트가 교차 오염되거나 조기 종료되는 버그를 재현/방지한다.

import { describe, it, expect, afterEach } from 'vitest';
import type { ExecuteOptions, ProviderEvent } from '@star-cliproxy/shared';
import type { CodexAppServerProcess } from './codex-appserver-process.js';
import { CodexAppServerSessionManager } from './codex-appserver-session-manager.js';
import {
  executeAppServer,
  executeStreamAppServer,
  type AppServerExecutorConfig,
} from './codex-appserver-executor.js';

const TICK_MS = 5;
const MODEL = 'gpt-5.3-codex';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function usageBlock() {
  return {
    totalTokens: 30,
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 20,
    reasoningOutputTokens: 0,
  };
}

// 실제 codex app-server의 JSON-RPC stdio 동작을 재현하는 mock:
// - 알림은 등록된 전체 핸들러에 브로드캐스트 (프로세스 공유와 동일)
// - turn/start마다 프롬프트 기반 응답을 청크 단위로 비동기 방출
// - 같은 thread에 turn이 동시에 들어오면 알림이 교차 방출됨 (버그 재현 조건)
class MockAppServer {
  private handlers = new Map<string, Set<(params: unknown) => void>>();
  private threadCounter = 0;
  private turnCounter = 0;
  private activeTurnsByThread = new Map<string, number>();
  private activeTurnsTotal = 0;

  // 동시성 관측 지표
  maxConcurrentTurnsPerThread = 0;
  maxConcurrentTurnsTotal = 0;

  isAlive(): boolean {
    return true;
  }

  resetRestartCount(): void {}

  sendNotification(): void {}

  onNotification(method: string, handler: (params: unknown) => void): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;

    if (method === 'thread/start') {
      return { thread: { id: `thread-${++this.threadCounter}` } };
    }
    if (method === 'thread/resume') {
      return { thread: { id: p.threadId } };
    }
    if (method === 'turn/start') {
      const threadId = p.threadId as string;
      const input = p.input as Array<{ text: string }>;
      const promptText = input[0]?.text ?? '';
      // fire-and-forget: 실제 서버처럼 응답 후 알림을 비동기로 방출
      void this.runTurn(threadId, `turn-${++this.turnCounter}`, promptText);
      return {};
    }
    throw new Error(`예상치 못한 JSON-RPC 메서드: ${method}`);
  }

  private emit(method: string, params: unknown): void {
    for (const handler of [...(this.handlers.get(method) ?? [])]) {
      handler(params);
    }
  }

  // 프롬프트에서 결정적으로 응답 생성: "echo(<prompt>)" — turn 할당 순서와 무관하게 검증 가능
  private async runTurn(threadId: string, turnId: string, promptText: string): Promise<void> {
    const active = (this.activeTurnsByThread.get(threadId) ?? 0) + 1;
    this.activeTurnsByThread.set(threadId, active);
    this.activeTurnsTotal++;
    this.maxConcurrentTurnsPerThread = Math.max(this.maxConcurrentTurnsPerThread, active);
    this.maxConcurrentTurnsTotal = Math.max(this.maxConcurrentTurnsTotal, this.activeTurnsTotal);

    const chunks = ['echo(', promptText, ')'];
    for (const chunk of chunks) {
      await delay(TICK_MS);
      this.emit('item/agentMessage/delta', {
        threadId,
        turnId,
        itemId: `item-${turnId}`,
        delta: chunk,
      });
    }

    this.emit('item/completed', {
      threadId,
      turnId,
      item: { type: 'agentMessage', id: `item-${turnId}`, text: chunks.join('') },
    });
    this.emit('thread/tokenUsage/updated', {
      threadId,
      turnId,
      tokenUsage: { total: usageBlock(), last: usageBlock() },
    });

    await delay(TICK_MS);
    this.activeTurnsByThread.set(threadId, this.activeTurnsByThread.get(threadId)! - 1);
    this.activeTurnsTotal--;
    this.emit('turn/completed', {
      threadId,
      turn: { id: turnId, status: 'completed', error: null },
    });
  }
}

function createOptions(prompt: string, stream = false): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: prompt }],
    model: MODEL,
    stream,
  };
}

function createConfig(
  proc: MockAppServer,
  sessionManager: CodexAppServerSessionManager,
  clientKey: string,
): AppServerExecutorConfig {
  return {
    model: MODEL,
    options: {},
    process: proc as unknown as CodexAppServerProcess,
    sessionManager,
    clientKey,
    timeoutMs: 5000,
  };
}

async function collectStreamText(gen: AsyncGenerator<ProviderEvent, void>): Promise<string> {
  const texts: string[] = [];
  for await (const event of gen) {
    if (event.type === 'text_delta') {
      texts.push(event.text);
    }
    if (event.type === 'error') {
      throw new Error(event.error);
    }
  }
  return texts.join('');
}

describe('codex app-server 동시성 (#24)', () => {
  let sessionManager: CodexAppServerSessionManager;

  afterEach(() => {
    sessionManager?.destroy();
  });

  it('non-stream: 같은 clientKey+model 동시 요청이 서로의 응답을 오염시키지 않는다', async () => {
    const proc = new MockAppServer();
    sessionManager = new CodexAppServerSessionManager();
    // 같은 스레드를 공유하도록 사전 시드 (세션 재사용 시나리오)
    sessionManager.set('client-1', 'thread-shared', MODEL);

    const [resultA, resultB] = await Promise.all([
      executeAppServer(createOptions('prompt-A'), createConfig(proc, sessionManager, 'client-1')),
      executeAppServer(createOptions('prompt-B'), createConfig(proc, sessionManager, 'client-1')),
    ]);

    expect(resultA.content).toContain('prompt-A');
    expect(resultA.content).not.toContain('prompt-B');
    expect(resultB.content).toContain('prompt-B');
    expect(resultB.content).not.toContain('prompt-A');
  });

  it('stream: 같은 clientKey+model 동시 요청의 delta가 교차 유입되지 않는다', async () => {
    const proc = new MockAppServer();
    sessionManager = new CodexAppServerSessionManager();
    sessionManager.set('client-1', 'thread-shared', MODEL);

    const [textA, textB] = await Promise.all([
      collectStreamText(
        executeStreamAppServer(
          createOptions('prompt-A', true),
          createConfig(proc, sessionManager, 'client-1'),
        ),
      ),
      collectStreamText(
        executeStreamAppServer(
          createOptions('prompt-B', true),
          createConfig(proc, sessionManager, 'client-1'),
        ),
      ),
    ]);

    expect(textA).toContain('prompt-A');
    expect(textA).not.toContain('prompt-B');
    expect(textB).toContain('prompt-B');
    expect(textB).not.toContain('prompt-A');
  });

  it('같은 thread의 turn은 동시에 1개만 실행된다 (직렬화)', async () => {
    const proc = new MockAppServer();
    sessionManager = new CodexAppServerSessionManager();
    sessionManager.set('client-1', 'thread-shared', MODEL);

    await Promise.all([
      executeAppServer(createOptions('prompt-A'), createConfig(proc, sessionManager, 'client-1')),
      executeAppServer(createOptions('prompt-B'), createConfig(proc, sessionManager, 'client-1')),
      executeAppServer(createOptions('prompt-C'), createConfig(proc, sessionManager, 'client-1')),
    ]);

    expect(proc.maxConcurrentTurnsPerThread).toBe(1);
  });

  it('다른 thread의 turn은 여전히 병렬 실행된다 (과잉 직렬화 방지)', async () => {
    const proc = new MockAppServer();
    sessionManager = new CodexAppServerSessionManager();
    // 서로 다른 clientKey → 각자 새 thread 생성 → 병렬 허용
    const [resultA, resultB] = await Promise.all([
      executeAppServer(createOptions('prompt-A'), createConfig(proc, sessionManager, 'client-1')),
      executeAppServer(createOptions('prompt-B'), createConfig(proc, sessionManager, 'client-2')),
    ]);

    expect(resultA.content).toContain('prompt-A');
    expect(resultB.content).toContain('prompt-B');
    expect(proc.maxConcurrentTurnsPerThread).toBe(1);
    expect(proc.maxConcurrentTurnsTotal).toBeGreaterThanOrEqual(2);
  });

  it('non-stream + stream 혼합 동시 요청도 직렬화된다', async () => {
    const proc = new MockAppServer();
    sessionManager = new CodexAppServerSessionManager();
    sessionManager.set('client-1', 'thread-shared', MODEL);

    const [resultA, textB] = await Promise.all([
      executeAppServer(createOptions('prompt-A'), createConfig(proc, sessionManager, 'client-1')),
      collectStreamText(
        executeStreamAppServer(
          createOptions('prompt-B', true),
          createConfig(proc, sessionManager, 'client-1'),
        ),
      ),
    ]);

    expect(resultA.content).toContain('prompt-A');
    expect(resultA.content).not.toContain('prompt-B');
    expect(textB).toContain('prompt-B');
    expect(textB).not.toContain('prompt-A');
    expect(proc.maxConcurrentTurnsPerThread).toBe(1);
  });
});
