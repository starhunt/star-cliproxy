import type {
  ExecuteOptions,
  ExecuteResult,
  ProviderEvent,
  HealthStatus,
  ProviderConfigYaml,
  HttpProviderConfig,
  DebugCaptureInfo,
} from '@star-cliproxy/shared';
import { BaseProvider } from './base-provider.js';

/**
 * OpenAI 호환 HTTP API 프로바이더.
 * MLX serve, llama.cpp server, vLLM, Ollama 등 로컬 서비스 지원.
 *
 * BaseProvider를 확장하되 CLI 관련 메서드는 모두 오버라이드하여
 * fetch 기반 HTTP 요청으로 대체한다.
 */
export class HttpProvider extends BaseProvider {
  readonly name: string;
  private httpConfig: HttpProviderConfig;

  constructor(providerName: string, httpConfig: HttpProviderConfig) {
    // BaseProvider에 최소한의 ProviderConfigYaml 전달 (CLI 코드 경로는 사용되지 않음)
    const baseConfig: ProviderConfigYaml = {
      enabled: httpConfig.enabled,
      cli_path: '',
      default_model: httpConfig.default_model,
      max_concurrent: httpConfig.max_concurrent,
      timeout_ms: httpConfig.timeout_ms,
      extra_args: [],
    };
    super(baseConfig);
    this.name = providerName;
    this.httpConfig = httpConfig;
    // HTTP Provider는 자체 SSE 파싱 → BaseProvider의 parser 불필요
    this.parser = { parse: () => null };
  }

  // CLI 전용 — 사용되지 않음
  protected buildArgs(): string[] {
    return [];
  }

  updateConfig(partial: Partial<ProviderConfigYaml>): void {
    super.updateConfig(partial);
    // httpConfig도 동기화
    if ('enabled' in partial) this.httpConfig.enabled = partial.enabled!;
    if ('default_model' in partial) this.httpConfig.default_model = partial.default_model!;
    if ('max_concurrent' in partial) this.httpConfig.max_concurrent = partial.max_concurrent!;
    if ('timeout_ms' in partial) this.httpConfig.timeout_ms = partial.timeout_ms!;
  }

  updateHttpConfig(partial: Partial<HttpProviderConfig>): void {
    Object.assign(this.httpConfig, partial);
    // BaseProvider config 동기화
    super.updateConfig({
      enabled: this.httpConfig.enabled,
      default_model: this.httpConfig.default_model,
      max_concurrent: this.httpConfig.max_concurrent,
      timeout_ms: this.httpConfig.timeout_ms,
    });
  }

  getHttpConfig(): HttpProviderConfig {
    return { ...this.httpConfig };
  }

  // === HTTP 요청 헬퍼 ===

  // base_url은 ~/v1까지 포함 (OpenAI SDK 컨벤션)
  // 예: http://localhost:8080/v1 → http://localhost:8080/chat/completions
  private buildUrl(path: string): string {
    const base = this.httpConfig.base_url.replace(/\/+$/, '');
    return `${base}${path}`;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.httpConfig.api_key) {
      headers['Authorization'] = `Bearer ${this.httpConfig.api_key}`;
    }
    if (this.httpConfig.custom_headers) {
      Object.assign(headers, this.httpConfig.custom_headers);
    }
    return headers;
  }

  private buildRequestBody(options: ExecuteOptions, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: options.messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      stream,
    };
    body.max_tokens = options.maxTokens ?? this.httpConfig.default_max_tokens ?? 65536;
    if (options.temperature !== undefined) body.temperature = options.temperature;
    return body;
  }

  // === Non-streaming 실행 ===

  async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const url = this.buildUrl('/chat/completions');
    const headers = this.buildHeaders();
    const body = this.buildRequestBody(options, false);

    const debugInfo: Partial<DebugCaptureInfo> = {
      cliArgs: [], // CLI 미사용
      httpRequest: {
        method: 'POST',
        url,
        headers: maskApiKey(headers),
        body,
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.httpConfig.timeout_ms);

    // 외부 signal 연결
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const rawText = await response.text();
      let responseBody: OpenAIChatCompletionResponse;
      try {
        responseBody = JSON.parse(rawText) as OpenAIChatCompletionResponse;
      } catch {
        // JSON 파싱 실패 시 raw text를 디버그에 포함하고 에러
        debugInfo.rawResponseText = rawText;
        debugInfo.httpResponse = {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        };
        options.onDebug?.(debugInfo as DebugCaptureInfo);
        throw new Error(`${this.name}: Invalid JSON response: ${rawText.slice(0, 200)}`);
      }

      debugInfo.rawResponseText = rawText;
      debugInfo.httpResponse = {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
      };

      if (!response.ok) {
        options.onDebug?.(debugInfo as DebugCaptureInfo);
        const errMsg = (responseBody as Record<string, unknown>).error
          ? JSON.stringify((responseBody as Record<string, unknown>).error)
          : `HTTP ${response.status}`;
        throw new Error(`${this.name} HTTP error: ${errMsg}`);
      }

      options.onDebug?.(debugInfo as DebugCaptureInfo);

      const choice = responseBody.choices?.[0];
      // content 우선, 비어있으면 reasoning fallback (reasoning 모델 지원)
      const content = choice?.message?.content || choice?.message?.reasoning || '';
      const usage = responseBody.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      return {
        content,
        usage: {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
        },
        finishReason: mapFinishReason(choice?.finish_reason),
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        if (options.signal?.aborted) {
          throw new Error('Request cancelled');
        }
        throw new Error(`${this.name} HTTP request timed out after ${this.httpConfig.timeout_ms}ms`);
      }
      // 디버그 정보 전달 (응답 없이 실패한 경우)
      if (!debugInfo.httpResponse) {
        options.onDebug?.(debugInfo as DebugCaptureInfo);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // === Streaming 실행 ===

  async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    const url = this.buildUrl('/chat/completions');
    const headers = this.buildHeaders();
    const body = this.buildRequestBody(options, true);

    const streamLines: string[] = [];
    const captureDebug = !!options.onDebug;

    const debugInfo: Partial<DebugCaptureInfo> = {
      cliArgs: [],
      httpRequest: {
        method: 'POST',
        url,
        headers: maskApiKey(headers),
        body,
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.httpConfig.timeout_ms);

    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        debugInfo.rawResponseText = errorBody;
        debugInfo.httpResponse = {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: errorBody,
        };
        options.onDebug?.(debugInfo as DebugCaptureInfo);
        throw new Error(`${this.name} HTTP error: ${response.status} ${errorBody.slice(0, 200)}`);
      }

      debugInfo.httpResponse = {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      };

      if (!response.body) {
        throw new Error(`${this.name}: No response body for streaming request`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          // 마지막 줄은 불완전할 수 있으므로 버퍼에 유지
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (captureDebug) streamLines.push(trimmed);

            const events = parseSSELineToEvents(trimmed);
            for (const event of events) {
              yield event;
              if (event.type === 'done') return;
            }
          }
        }

        // 버퍼에 남은 데이터 처리
        if (buffer.trim()) {
          if (captureDebug) streamLines.push(buffer.trim());
          const events = parseSSELineToEvents(buffer.trim());
          for (const event of events) yield event;
        }
      } finally {
        reader.releaseLock();
      }
    } finally {
      clearTimeout(timeoutId);
      if (captureDebug) {
        debugInfo.httpStreamLines = streamLines;
        debugInfo.rawResponseText = streamLines.join('\n');
        options.onDebug?.(debugInfo as DebugCaptureInfo);
      }
    }
  }

  // === Health Check ===

  async checkHealth(): Promise<HealthStatus> {
    try {
      const url = this.buildUrl('/models');
      const headers = this.buildHeaders();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
        return response.ok ? 'healthy' : 'unhealthy';
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      return 'unhealthy';
    }
  }
}

// === SSE 파싱 ===

function parseSSELineToEvents(line: string): ProviderEvent[] {
  // OpenAI SSE 형식: "data: {...}" 또는 "data: [DONE]"
  if (!line.startsWith('data: ')) return [];

  const data = line.slice(6); // "data: " 제거

  if (data === '[DONE]') {
    return [{ type: 'done' }];
  }

  try {
    const json = JSON.parse(data) as OpenAIChatCompletionChunk;
    const delta = json.choices?.[0]?.delta;
    const finishReason = json.choices?.[0]?.finish_reason;

    if (finishReason) {
      const events: ProviderEvent[] = [];
      if (json.usage) {
        events.push({
          type: 'usage',
          usage: {
            promptTokens: json.usage.prompt_tokens ?? 0,
            completionTokens: json.usage.completion_tokens ?? 0,
            totalTokens: json.usage.total_tokens ?? 0,
          },
        });
      }
      const reason = finishReason === 'length' ? 'length' as const
        : finishReason === 'tool_calls' ? 'tool_use' as const
        : 'stop' as const;
      events.push({ type: 'done', finishReason: reason });
      return events;
    }

    const events: ProviderEvent[] = [];

    // content 우선, 비어있으면 reasoning fallback (reasoning 모델 지원)
    const text = delta?.content || delta?.reasoning;
    if (text) {
      events.push({ type: 'text_delta', text });
    }

    // tool_calls 지원
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        events.push({
          type: 'tool_use',
          toolCallId: tc.id ?? '',
          toolName: tc.function?.name ?? '',
          input: tc.function?.arguments ?? '',
          isPartial: !tc.id, // id가 없으면 partial delta
        });
      }
    }

    return events;
  } catch {
    return [];
  }
}

// === OpenAI 응답 타입 (내부용) ===

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string; reasoning?: string; role?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface OpenAIChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning?: string;
      role?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

// === 유틸리티 ===

function mapFinishReason(reason?: string): 'stop' | 'length' | 'error' {
  if (reason === 'length') return 'length';
  return 'stop';
}

function maskApiKey(headers: Record<string, string>): Record<string, string> {
  const masked = { ...headers };
  if (masked['Authorization']) {
    const token = masked['Authorization'].replace('Bearer ', '');
    if (token.length > 8) {
      masked['Authorization'] = `Bearer ${token.slice(0, 4)}...${token.slice(-4)}`;
    }
  }
  return masked;
}
