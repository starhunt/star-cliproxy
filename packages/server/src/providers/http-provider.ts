import type {
  ChatResponseFormat,
  ExecuteOptions,
  ExecuteResult,
  EmbeddingOptions,
  EmbeddingResult,
  RerankOptions,
  RerankResult,
  TtsOptions,
  TtsResult,
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
  override readonly endpointTypes = ['chat', 'embeddings', 'tts', 'rerank'] as const;
  private httpConfig: HttpProviderConfig;
  /** 업스트림에서 마지막으로 통한 rerank 페이로드 규격 (없으면 TEI부터 시도) */
  private rerankWireFormat: RerankWireFormat | null = null;

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

  // cliproxy가 직접 관리하는 표준 필드. extra_body가 이 키들을 덮어쓰지 못하게 보호.
  private static readonly RESERVED_BODY_KEYS = new Set([
    'model', 'messages', 'stream', 'max_tokens', 'temperature', 'tools', 'tool_choice',
  ]);

  // OpenAI 호환 백엔드가 response_format을 직접 해석하므로 세 타입 모두 그대로 전달한다.
  // 백엔드가 실제로 지원하는지는 백엔드 응답(에러)으로 드러난다.
  override supportsResponseFormat(_format: ChatResponseFormat): boolean {
    return true;
  }

  private buildRequestBody(options: ExecuteOptions, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: options.model,
      // role/content 외에 function calling 필드(name, tool_call_id, tool_calls)도 보존해야
      // 멀티턴 도구 대화(assistant tool_calls → tool 결과 → 후속 응답)가 백엔드에 온전히 전달됨.
      messages: options.messages.map(m => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.name !== undefined) msg.name = m.name;
        if (m.tool_call_id !== undefined) msg.tool_call_id = m.tool_call_id;
        if (m.tool_calls !== undefined) msg.tool_calls = m.tool_calls;
        return msg;
      }),
      stream,
    };
    // function calling 패스스루: tools가 있을 때만 백엔드로 전달.
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      if (options.toolChoice !== undefined) body.tool_choice = options.toolChoice;
    }
    // structured output 패스스루: OpenAI 호환 백엔드가 스키마를 직접 강제한다.
    // RESERVED_BODY_KEYS에는 넣지 않는다 — 이 필드가 배선되기 전부터 extra_body로
    // response_format을 지정해 온 설정을 조용히 무력화하지 않기 위해서다.
    if (options.chatResponseFormat) body.response_format = options.chatResponseFormat;
    // max_tokens 미지정 시 필드 자체를 생략 → 서버 기본값 사용 (vLLM 등의 max_total_tokens 제한 회피)
    const maxTokens = options.maxTokens ?? this.httpConfig.default_max_tokens;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    if (options.temperature !== undefined) body.temperature = options.temperature;

    // extra_body 머지: 백엔드 비표준 필드 패스스루 (chat_template_kwargs, top_k, think 등).
    // 표준 필드(모델/메시지 등)는 cliproxy가 우선 — extra_body로 덮어쓰기 차단.
    if (options.extraBody && typeof options.extraBody === 'object') {
      for (const [key, value] of Object.entries(options.extraBody)) {
        if (HttpProvider.RESERVED_BODY_KEYS.has(key)) continue;
        if (value === undefined) continue;
        body[key] = value;
      }
    }
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
      const msg = choice?.message;
      // 분리 필드 우선: 백엔드가 reasoning_content/reasoning을 별도로 보내면 그대로 보존.
      // 시간차 폴백: content가 비고 reasoning만 있는 경우(일부 백엔드)도 reasoning을 답변으로.
      const rawContent = msg?.content ?? '';
      const rawReasoning = msg?.reasoning_content ?? msg?.reasoning ?? '';
      const content = rawContent || rawReasoning || '';
      const reasoning = rawContent ? rawReasoning : '';
      const usage = responseBody.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      // function calling: 백엔드가 반환한 tool_calls를 OpenAI 포맷 그대로 보존.
      const toolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0
        ? msg.tool_calls.map((tc) => ({
            id: tc.id ?? '',
            type: 'function' as const,
            function: {
              name: tc.function?.name ?? '',
              arguments: tc.function?.arguments ?? '',
            },
            ...(typeof tc.index === 'number' ? { index: tc.index } : {}),
          }))
        : undefined;

      return {
        content,
        ...(reasoning ? { reasoning } : {}),
        ...(toolCalls ? { toolCalls } : {}),
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
        // SSE 'done' 수신으로 조기 return하거나 소비자가 generator를 조기 종료한 경우,
        // releaseLock만으로는 fetch body 스트림이 취소되지 않아 백엔드 소켓이 timeout까지 잔류한다.
        // cancel()은 스트림을 명시적으로 닫고 lock도 해제한다(정상 완료 시엔 no-op).
        await reader.cancel().catch(() => {});
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

  // === Embedding 실행 ===

  async executeEmbedding(options: EmbeddingOptions): Promise<EmbeddingResult> {
    const url = this.buildUrl('/embeddings');
    const headers = this.buildHeaders();
    const body: Record<string, unknown> = {
      model: options.model,
      input: options.input,
    };
    if (options.encodingFormat) body.encoding_format = options.encodingFormat;
    if (options.dimensions) body.dimensions = options.dimensions;

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

      const rawText = await response.text();
      let responseBody: OpenAIEmbeddingResponse;
      try {
        responseBody = JSON.parse(rawText) as OpenAIEmbeddingResponse;
      } catch {
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

      const embeddings = (responseBody.data ?? [])
        .sort((a, b) => a.index - b.index)
        .map(d => d.embedding);
      const usage = responseBody.usage ?? { prompt_tokens: 0, total_tokens: 0 };

      return {
        embeddings,
        model: responseBody.model ?? options.model,
        usage: {
          promptTokens: usage.prompt_tokens ?? 0,
          totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0),
        },
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        if (options.signal?.aborted) {
          throw new Error('Request cancelled');
        }
        throw new Error(`${this.name} HTTP request timed out after ${this.httpConfig.timeout_ms}ms`);
      }
      if (!debugInfo.httpResponse) {
        options.onDebug?.(debugInfo as DebugCaptureInfo);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // === Rerank 실행 ===
  // 업스트림 rerank 규격은 두 갈래라 자동 협상한다.
  //   - TEI 네이티브 : `{query, texts}`            → `[{index, score, text?}]`
  //   - OpenAI 호환  : `{model, query, documents}` → `{results:[{index, relevance_score}]}`
  //     (cliproxy 자신·Cohere·Jina 계열. cliproxy를 업스트림으로 체인하면 이쪽이다)
  // 먼저 한 규격으로 보내고 400/422가 오면 반대 규격으로 재시도한다. 통한 규격은 기억해
  // 이후 왕복을 1회로 줄이되, 업스트림이 교체돼 다시 어긋나면 폴백으로 자동 복구된다.
  // base_url이 `.../v1`로 끝나면 buildUrl('/rerank')은 `.../v1/rerank`가 되므로,
  // `/v1/rerank`가 없는 TEI 직결이라면 reverse-proxy/사이드카에서 `/rerank`로 rewrite 필요.

  async executeRerank(options: RerankOptions): Promise<RerankResult> {
    const preferred = this.rerankWireFormat ?? 'tei';
    const order: RerankWireFormat[] = preferred === 'tei' ? ['tei', 'openai'] : ['openai', 'tei'];

    let attempt = await this.attemptRerank(order[0], options);
    if (!attempt.ok && attempt.formatMismatch) {
      attempt = await this.attemptRerank(order[1], options);
      if (attempt.ok) this.rerankWireFormat = order[1];
    } else if (attempt.ok) {
      this.rerankWireFormat = order[0];
    }

    options.onDebug?.(attempt.debugInfo as DebugCaptureInfo);
    if (!attempt.ok) throw attempt.error;
    return attempt.result;
  }

  /**
   * rerank 1회 시도. 던지지 않고 결과를 반환해 호출부가 폴백 여부를 판단하게 한다.
   * (onDebug는 호출부가 최종 시도분만 1회 호출 — 기존 계약 유지)
   */
  private async attemptRerank(
    format: RerankWireFormat,
    options: RerankOptions,
  ): Promise<RerankAttempt> {
    const url = this.buildUrl('/rerank');
    const headers = this.buildHeaders();
    const body: Record<string, unknown> =
      format === 'openai'
        ? {
            model: options.model,
            query: options.query,
            documents: options.documents,
            ...(options.returnDocuments ? { return_documents: true } : {}),
            ...(typeof options.topN === 'number' && options.topN > 0
              ? { top_n: options.topN }
              : {}),
          }
        : {
            query: options.query,
            texts: options.documents,
            ...(options.returnDocuments ? { return_text: true } : {}),
          };

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
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const rawText = await response.text();
      debugInfo.rawResponseText = rawText;

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        debugInfo.httpResponse = {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        };
        return {
          ok: false,
          formatMismatch: false,
          debugInfo,
          error: new Error(`${this.name}: Invalid JSON response: ${rawText.slice(0, 200)}`),
        };
      }

      debugInfo.httpResponse = {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: parsed as Record<string, unknown>,
      };

      if (!response.ok) {
        const errObj = (parsed as Record<string, unknown>)?.error;
        const errMsg = errObj ? JSON.stringify(errObj) : `HTTP ${response.status}`;
        return {
          ok: false,
          // 400/422 = 업스트림이 페이로드를 못 알아들은 것 → 반대 규격으로 재시도할 가치가 있다.
          // 401/403(인증)·404(경로 없음)·429·5xx는 규격을 바꿔도 같은 결과라 재시도하지 않는다.
          formatMismatch: response.status === 400 || response.status === 422,
          debugInfo,
          error: new Error(`${this.name} HTTP error: ${errMsg}`),
        };
      }

      const normalized = normalizeRerankResponse(parsed);
      if (!normalized) {
        return {
          ok: false,
          // 200인데 형태를 모르겠다면 규격이 어긋난 것 — 반대 규격으로 한 번 더.
          formatMismatch: true,
          debugInfo,
          error: new Error(
            `${this.name}: Unrecognized rerank response shape: ${rawText.slice(0, 200)}`,
          ),
        };
      }

      let results = normalized.items.map((item) => ({
        index: item.index,
        relevanceScore: item.relevanceScore,
        ...(options.returnDocuments && typeof item.document === 'string'
          ? { document: item.document }
          : {}),
      }));

      // 업스트림이 보통 내림차순으로 주지만, 일관성을 위해 명시적으로 정렬.
      results.sort((a, b) => b.relevanceScore - a.relevanceScore);

      if (typeof options.topN === 'number' && options.topN > 0) {
        results = results.slice(0, options.topN);
      }

      // TEI는 usage를 반환하지 않으므로 없을 때만 대략 추정 (문자 수 / 4).
      const totalTokens =
        normalized.totalTokens ??
        Math.ceil(
          (options.query.length + options.documents.reduce((sum, d) => sum + d.length, 0)) / 4,
        );

      return {
        ok: true,
        debugInfo,
        result: { results, model: options.model, usage: { totalTokens } },
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          ok: false,
          formatMismatch: false,
          debugInfo,
          error: options.signal?.aborted
            ? new Error('Request cancelled')
            : new Error(
                `${this.name} HTTP request timed out after ${this.httpConfig.timeout_ms}ms`,
              ),
        };
      }
      return {
        ok: false,
        formatMismatch: false,
        debugInfo,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    } finally {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  // === TTS 실행 ===

  async executeTts(options: TtsOptions): Promise<TtsResult> {
    const url = this.buildUrl('/audio/speech');
    const headers = this.buildHeaders();
    const body: Record<string, unknown> = {
      model: options.model,
      input: options.input,
      voice: options.voice,
    };
    if (options.responseFormat) body.response_format = options.responseFormat;
    if (options.speed !== undefined) body.speed = options.speed;

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
        const errorText = await response.text();
        debugInfo.rawResponseText = errorText;
        debugInfo.httpResponse = {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        };
        options.onDebug?.(debugInfo as DebugCaptureInfo);
        throw new Error(`${this.name} HTTP error: ${response.status} ${errorText.slice(0, 200)}`);
      }

      const contentType = response.headers.get('content-type') ?? 'audio/mpeg';
      const arrayBuffer = await response.arrayBuffer();
      const audio = Buffer.from(arrayBuffer);

      debugInfo.httpResponse = {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      };
      options.onDebug?.(debugInfo as DebugCaptureInfo);

      return { audio, contentType };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        if (options.signal?.aborted) {
          throw new Error('Request cancelled');
        }
        throw new Error(`${this.name} HTTP request timed out after ${this.httpConfig.timeout_ms}ms`);
      }
      if (!debugInfo.httpResponse) {
        options.onDebug?.(debugInfo as DebugCaptureInfo);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
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

    // reasoning_content/reasoning은 thinking 이벤트로, content는 text_delta로 분리 emit.
    // 백엔드(vLLM/sglang 등)가 reasoning_parser를 켠 경우 별도 필드로 도착한다.
    const reasoningText = delta?.reasoning_content || delta?.reasoning;
    if (reasoningText) {
      events.push({ type: 'thinking', text: reasoningText });
    }
    if (delta?.content) {
      events.push({ type: 'text_delta', text: delta.content });
    }

    // tool_calls 지원: 병렬 호출 구분을 위해 backend의 index를 보존.
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        events.push({
          type: 'tool_use',
          toolCallId: tc.id ?? '',
          toolName: tc.function?.name ?? '',
          input: tc.function?.arguments ?? '',
          isPartial: !tc.id, // id가 없으면 partial delta
          ...(typeof tc.index === 'number' ? { index: tc.index } : {}),
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
    message?: {
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
      role?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
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
      reasoning_content?: string;
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

interface OpenAIEmbeddingResponse {
  object?: string;
  data?: Array<{
    object?: string;
    embedding: number[];
    index: number;
  }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
}

// rerank 업스트림 페이로드 규격. TEI 네이티브 vs OpenAI 호환(cliproxy·Cohere·Jina).
type RerankWireFormat = 'tei' | 'openai';

// attemptRerank의 결과 — 던지는 대신 반환해 호출부가 폴백을 결정한다.
type RerankAttempt =
  | { ok: true; result: RerankResult; debugInfo: Partial<DebugCaptureInfo> }
  | {
      ok: false;
      /** 페이로드 규격 불일치로 보이는가 (반대 규격 재시도 대상) */
      formatMismatch: boolean;
      error: Error;
      debugInfo: Partial<DebugCaptureInfo>;
    };

type NormalizedRerankItem = { index: number; relevanceScore: number; document?: string };

/**
 * TEI/OpenAI 두 응답 형태를 공통 구조로 정규화. 어느 쪽도 아니면 null.
 * (요청 규격과 응답 규격이 항상 짝을 이루진 않으므로 응답만 보고 판별한다)
 */
function normalizeRerankResponse(
  parsed: unknown,
): { items: NormalizedRerankItem[]; totalTokens?: number } | null {
  // TEI: 최상위가 배열
  if (Array.isArray(parsed)) {
    const items: NormalizedRerankItem[] = [];
    for (const raw of parsed) {
      const item = raw as { index?: unknown; score?: unknown; text?: unknown };
      if (typeof item?.index !== 'number' || typeof item?.score !== 'number') return null;
      items.push({
        index: item.index,
        relevanceScore: item.score,
        ...(typeof item.text === 'string' ? { document: item.text } : {}),
      });
    }
    return { items };
  }

  // OpenAI/Cohere 호환: `{results: [...], usage?: {total_tokens}}`
  const root = parsed as { results?: unknown; usage?: { total_tokens?: unknown } } | null;
  if (!Array.isArray(root?.results)) return null;

  const items: NormalizedRerankItem[] = [];
  for (const raw of root.results) {
    const item = raw as {
      index?: unknown;
      relevance_score?: unknown;
      score?: unknown;
      document?: unknown;
    };
    const score = typeof item?.relevance_score === 'number' ? item.relevance_score : item?.score;
    if (typeof item?.index !== 'number' || typeof score !== 'number') return null;
    // Cohere는 document를 `{text}` 객체로, 그 외는 문자열로 준다.
    const doc =
      typeof item.document === 'string'
        ? item.document
        : typeof (item.document as { text?: unknown })?.text === 'string'
          ? ((item.document as { text: string }).text)
          : undefined;
    items.push({
      index: item.index,
      relevanceScore: score,
      ...(doc !== undefined ? { document: doc } : {}),
    });
  }

  const total = root?.usage?.total_tokens;
  return { items, ...(typeof total === 'number' ? { totalTokens: total } : {}) };
}

// === 유틸리티 ===

function mapFinishReason(reason?: string): 'stop' | 'length' | 'tool_calls' | 'error' {
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls') return 'tool_calls';
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
