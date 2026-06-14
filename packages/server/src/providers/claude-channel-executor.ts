import type {
  ClaudeChannelOptions,
  ExecuteOptions,
  ExecuteResult,
  ProviderEvent,
  TokenUsage,
} from '@star-cliproxy/shared';
import { convertMessages } from '../utils/message-converter.js';

export interface ChannelExecutorConfig {
  model: string;
  channelOptions: ClaudeChannelOptions;
  timeoutMs: number;
}

interface SubmittedJob {
  jobId: string;
  statusUrl: string;
  raw: Record<string, unknown>;
}

interface ChannelJobRecord {
  status?: string;
  result?: unknown;
  content?: unknown;
  text?: unknown;
  summary?: unknown;
  error?: unknown;
  usage?: unknown;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Request cancelled'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Request cancelled'));
    }, { once: true });
  });
}

function estimateUsage(prompt: string, content: string): TokenUsage {
  const promptTokens = Math.ceil(prompt.length / 4);
  const completionTokens = Math.ceil(content.length / 4);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

function parseUsage(value: unknown, fallback: TokenUsage): TokenUsage {
  if (!value || typeof value !== 'object') return fallback;
  const usage = value as Record<string, unknown>;
  const promptTokens = typeof usage.promptTokens === 'number' ? usage.promptTokens
    : typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens
      : fallback.promptTokens;
  const completionTokens = typeof usage.completionTokens === 'number' ? usage.completionTokens
    : typeof usage.completion_tokens === 'number' ? usage.completion_tokens
      : fallback.completionTokens;
  const totalTokens = typeof usage.totalTokens === 'number' ? usage.totalTokens
    : typeof usage.total_tokens === 'number' ? usage.total_tokens
      : promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function stringifyResult(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.result === 'string') return obj.result;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function makePrompt(options: ExecuteOptions): { systemPrompt: string; userPrompt: string; prompt: string } {
  const { systemPrompt, userPrompt } = convertMessages(options.messages);
  const prompt = systemPrompt
    ? `System:\n${systemPrompt}\n\nUser:\n${userPrompt}`
    : userPrompt;
  return { systemPrompt: systemPrompt ?? '', userPrompt, prompt };
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Claude channel bridge returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new Error(`Claude channel bridge returned non-JSON response: ${text.slice(0, 500)}`);
}

function channelHeaders(options: ClaudeChannelOptions): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.api_key) headers.Authorization = `Bearer ${options.api_key}`;
  return headers;
}

async function submitJob(
  options: ExecuteOptions,
  config: ChannelExecutorConfig,
  promptInfo: ReturnType<typeof makePrompt>,
): Promise<SubmittedJob> {
  const endpointUrl = config.channelOptions.endpoint_url;
  if (!endpointUrl) {
    throw new Error('Claude channel-worker mode requires channel_options.endpoint_url.');
  }

  const baseUrl = trimTrailingSlash(endpointUrl);
  const body = {
    prompt: promptInfo.prompt,
    // user_prompt: 내장 bridge가 system과 user를 중복 없이 재구성하도록 분리 전달 (외부 bridge는 무시)
    user_prompt: promptInfo.userPrompt,
    system: promptInfo.systemPrompt || undefined,
    model: config.model,
    reasoning_effort: options.reasoningEffort,
    response_schema: config.channelOptions.response_schema,
    metadata: {
      source: 'star-cliproxy',
      client_key: options.clientKey,
      stream: options.stream,
      isolation: config.channelOptions.isolation ?? 'external',
    },
  };

  const response = await fetch(`${baseUrl}/jobs`, {
    method: 'POST',
    headers: channelHeaders(config.channelOptions),
    body: JSON.stringify(body),
    signal: options.signal,
  });
  const data = await readJsonResponse(response);
  const jobId = typeof data.job_id === 'string' ? data.job_id
    : typeof data.jobId === 'string' ? data.jobId
      : null;
  if (!jobId) {
    throw new Error('Claude channel bridge did not return job_id.');
  }
  const statusUrl = typeof data.status_url === 'string' ? data.status_url : `${baseUrl}/jobs/${jobId}`;
  return { jobId, statusUrl, raw: data };
}

async function pollJob(
  submitted: SubmittedJob,
  options: ExecuteOptions,
  config: ChannelExecutorConfig,
): Promise<ChannelJobRecord> {
  const startedAt = Date.now();
  const timeoutMs = config.channelOptions.result_timeout_ms ?? config.timeoutMs;
  const pollIntervalMs = config.channelOptions.poll_interval_ms ?? 500;

  while (true) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Claude channel job timed out after ${timeoutMs}ms: ${submitted.jobId}`);
    }
    const response = await fetch(submitted.statusUrl, {
      method: 'GET',
      headers: channelHeaders(config.channelOptions),
      signal: options.signal,
    });
    const data = await readJsonResponse(response) as ChannelJobRecord;
    const status = typeof data.status === 'string' ? data.status : '';

    if (status === 'completed') return data;
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      const errorText = stringifyResult(data.error || data.summary || status);
      throw new Error(`Claude channel job ${submitted.jobId} failed: ${errorText}`);
    }

    await sleep(pollIntervalMs, options.signal);
  }
}

export async function executeChannel(
  options: ExecuteOptions,
  config: ChannelExecutorConfig,
): Promise<ExecuteResult> {
  const promptInfo = makePrompt(options);
  const submitted = await submitJob(options, config, promptInfo);
  const record = submitted.raw.status === 'completed'
    ? submitted.raw as ChannelJobRecord
    : await pollJob(submitted, options, config);

  const content = stringifyResult(record.result ?? record.content ?? record.text ?? '');
  const fallbackUsage = estimateUsage(promptInfo.prompt, content);
  const usage = parseUsage(record.usage, fallbackUsage);

  options.onDebug?.({
    cliArgs: [
      '[channel-worker]',
      `endpoint=${config.channelOptions.endpoint_url ?? ''}`,
      `job=${submitted.jobId}`,
      `model=${config.model}`,
    ],
    stdout: content,
    rawResponseText: JSON.stringify(record),
  });

  return {
    content,
    usage,
    finishReason: 'stop',
  };
}

export async function* executeStreamChannel(
  options: ExecuteOptions,
  config: ChannelExecutorConfig,
): AsyncIterable<ProviderEvent> {
  const result = await executeChannel({ ...options, stream: false }, config);
  if (result.content) {
    yield { type: 'text_delta', text: result.content };
  }
  yield { type: 'usage', usage: result.usage };
  yield {
    type: 'done',
    finishReason: result.finishReason === 'tool_calls' ? 'tool_use' : result.finishReason,
  };
}
