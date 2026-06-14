import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecuteOptions } from '@star-cliproxy/shared';
import { executeChannel, executeStreamChannel } from './claude-channel-executor.js';

function createOptions(overrides?: Partial<ExecuteOptions>): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: 'Say hello' }],
    model: 'claude-sonnet-4-6',
    stream: false,
    ...overrides,
  };
}

function createConfig() {
  return {
    model: 'claude-sonnet-4-6',
    timeoutMs: 30_000,
    channelOptions: {
      endpoint_url: 'http://127.0.0.1:8788',
      poll_interval_ms: 1,
      result_timeout_ms: 100,
      isolation: 'external' as const,
    },
  };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('claude-channel-executor', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('submits a job and polls completed result', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/jobs') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(body.prompt).toContain('Say hello');
        expect(body.model).toBe('claude-sonnet-4-6');
        expect(body.metadata.source).toBe('star-cliproxy');
        return jsonResponse({
          ok: true,
          job_id: 'job-1',
          status: 'submitted',
          status_url: 'http://127.0.0.1:8788/jobs/job-1',
        });
      }
      if (href.endsWith('/jobs/job-1') && init?.method === 'GET') {
        return jsonResponse({
          job_id: 'job-1',
          status: 'completed',
          result: 'hello from channel',
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeChannel(createOptions(), createConfig());

    expect(result.content).toBe('hello from channel');
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 3, totalTokens: 15 });
    expect(result.finishReason).toBe('stop');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when the bridge reports failed status', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/jobs')) {
        return jsonResponse({ job_id: 'job-2', status_url: 'http://127.0.0.1:8788/jobs/job-2' });
      }
      return jsonResponse({ job_id: 'job-2', status: 'failed', error: 'permission denied' });
    }));

    await expect(executeChannel(createOptions(), createConfig()))
      .rejects.toThrow('permission denied');
  });

  it('wraps non-streaming channel result as provider stream events', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/jobs')) {
        return jsonResponse({ job_id: 'job-3', status_url: 'http://127.0.0.1:8788/jobs/job-3' });
      }
      return jsonResponse({ job_id: 'job-3', status: 'completed', result: 'stream body' });
    }));

    const events = [];
    for await (const event of executeStreamChannel(createOptions({ stream: true }), createConfig())) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: 'text_delta', text: 'stream body' });
    expect(events[1]).toMatchObject({ type: 'usage' });
    expect(events[2]).toEqual({ type: 'done', finishReason: 'stop' });
  });
});
