import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExecuteOptions, ClaudeSdkOptions } from '@star-cliproxy/shared';
import { ClaudeSdkSessionManager } from './claude-sdk-session-manager.js';

// SDK mock - query()가 반환할 메시지 시퀀스를 제어
const mockMessages: Record<string, unknown>[] = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: async function* () {
    for (const msg of mockMessages) {
      yield msg;
    }
  },
}));

// mock 설정 후 import (vi.mock은 호이스팅됨)
const { executeSdk, executeStreamSdk } = await import('./claude-sdk-executor.js');

function createOptions(overrides?: Partial<ExecuteOptions>): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: 'Hello' }],
    model: 'claude-sonnet-4-6',
    stream: false,
    ...overrides,
  };
}

function createConfig(sdkOptions?: Partial<ClaudeSdkOptions>) {
  return {
    model: 'claude-sonnet-4-6',
    sdkOptions: {
      max_turns: 5,
      permission_mode: 'bypassPermissions',
      ...sdkOptions,
    },
    workingDir: '/tmp',
    timeoutMs: 30000,
    cleanEnv: {},
    cliPath: 'claude',
  };
}

describe('claude-sdk-executor', () => {
  beforeEach(() => {
    mockMessages.length = 0;
  });

  describe('executeSdk', () => {
    it('assistant + result 메시지에서 content와 usage를 추출한다', async () => {
      mockMessages.push(
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-1',
          model: 'claude-sonnet-4-6',
          tools: [],
          mcp_servers: [],
        },
        {
          type: 'assistant',
          session_id: 'sess-1',
          message: {
            content: [
              { type: 'text', text: 'Hello! How can I help you?' },
            ],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-1',
          is_error: false,
          result: 'Hello! How can I help you?',
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 10,
          },
        },
      );

      const result = await executeSdk(createOptions(), createConfig());

      expect(result.content).toBe('Hello! How can I help you?');
      expect(result.usage.promptTokens).toBe(160); // 100 + 50 + 10
      expect(result.usage.completionTokens).toBe(20);
      expect(result.usage.totalTokens).toBe(180); // 160 + 20
      expect(result.finishReason).toBe('stop');
    });

    it('result만 있고 assistant가 없으면 result.result을 사용한다', async () => {
      mockMessages.push(
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-2',
          is_error: false,
          result: 'Fallback text',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      );

      const result = await executeSdk(createOptions(), createConfig());

      expect(result.content).toBe('Fallback text');
      expect(result.finishReason).toBe('stop');
    });

    it('에러 result를 처리한다', async () => {
      mockMessages.push(
        {
          type: 'result',
          subtype: 'error_max_turns',
          session_id: 'sess-3',
          is_error: true,
          errors: ['Max turns exceeded'],
          usage: {
            input_tokens: 50,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      );

      const result = await executeSdk(createOptions(), createConfig());

      expect(result.finishReason).toBe('length');
    });
  });

  describe('executeStreamSdk', () => {
    it('stream_event delta를 StreamChunk로 변환한다', async () => {
      mockMessages.push(
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-4',
        },
        {
          type: 'stream_event',
          session_id: 'sess-4',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Hello' },
          },
        },
        {
          type: 'stream_event',
          session_id: 'sess-4',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: ' World' },
          },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-4',
          is_error: false,
          usage: {
            input_tokens: 30,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      );

      const chunks: unknown[] = [];
      for await (const chunk of executeStreamSdk(
        createOptions({ stream: true }),
        createConfig(),
      )) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toEqual({ type: 'delta', content: 'Hello' });
      expect(chunks[1]).toEqual({ type: 'delta', content: ' World' });
      expect(chunks[2]).toEqual({
        type: 'done',
        usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 },
      });
    });

    it('에러 result를 error chunk + done으로 변환한다', async () => {
      mockMessages.push(
        {
          type: 'result',
          subtype: 'error_during_execution',
          session_id: 'sess-5',
          is_error: true,
          errors: ['Something went wrong'],
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      );

      const chunks: unknown[] = [];
      for await (const chunk of executeStreamSdk(
        createOptions({ stream: true }),
        createConfig(),
      )) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ type: 'error', error: 'Something went wrong' });
      expect(chunks[1]).toMatchObject({ type: 'done' });
    });
  });

  describe('세션 재사용', () => {
    it('세션 매니저에 session_id를 저장한다', async () => {
      mockMessages.push(
        {
          type: 'system',
          subtype: 'init',
          session_id: 'new-session-123',
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'new-session-123',
          is_error: false,
          result: 'Done',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      );

      const sessionManager = new ClaudeSdkSessionManager();
      const config = {
        ...createConfig(),
        sessionManager,
        clientKey: 'test-client',
      };

      await executeSdk(createOptions(), config);

      const session = sessionManager.get('test-client', 'claude-sonnet-4-6');
      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe('new-session-123');

      sessionManager.destroy();
    });
  });
});

describe('ClaudeSdkSessionManager', () => {
  let manager: ClaudeSdkSessionManager;

  beforeEach(() => {
    manager = new ClaudeSdkSessionManager(5000); // 5초 TTL
  });

  afterEach(() => {
    manager.destroy();
  });

  it('세션 저장 및 조회', () => {
    manager.set('client-1', 'sess-a', 'claude-sonnet-4-6');
    const session = manager.get('client-1', 'claude-sonnet-4-6');
    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe('sess-a');
  });

  it('모델 변경 시 세션 무효화', () => {
    manager.set('client-1', 'sess-a', 'claude-sonnet-4-6');
    const session = manager.get('client-1', 'claude-opus-4-6');
    expect(session).toBeNull();
  });

  it('수동 무효화', () => {
    manager.set('client-1', 'sess-a', 'claude-sonnet-4-6');
    manager.invalidate('client-1');
    const session = manager.get('client-1', 'claude-sonnet-4-6');
    expect(session).toBeNull();
  });

  it('TTL 만료 시 null 반환', async () => {
    manager.destroy(); // 기존 매니저 해제
    manager = new ClaudeSdkSessionManager(50); // 50ms TTL
    manager.set('client-1', 'sess-a', 'claude-sonnet-4-6');

    // TTL 대기
    await new Promise((resolve) => setTimeout(resolve, 100));

    const session = manager.get('client-1', 'claude-sonnet-4-6');
    expect(session).toBeNull();
  });

  it('size 추적', () => {
    expect(manager.size).toBe(0);
    manager.set('client-1', 'sess-a', 'model-a');
    manager.set('client-2', 'sess-b', 'model-b');
    expect(manager.size).toBe(2);
    manager.invalidate('client-1');
    expect(manager.size).toBe(1);
  });
});
