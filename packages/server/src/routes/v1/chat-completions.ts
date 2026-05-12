import type { FastifyInstance } from 'fastify';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessageContent,
  ChatMessageContentPart,
  ValidationConfig,
} from '@star-cliproxy/shared';
import { ALLOWED_ROLES, isReasoningEffort, type ReasoningEffort } from '@star-cliproxy/shared';
import { extractTextFromContent, isImagePart } from '../../utils/message-converter.js';
import { createRequestId, formatAsSSE } from '../../utils/stream-transformer.js';
import { extractClientKey } from '../../utils/client-key.js';
import { logRequest } from '../../middleware/request-logger.js';
import type { ModelRouter } from '../../services/router.js';
import type { QueueManager } from '../../services/queue.js';
import type { RateLimiter } from '../../middleware/rate-limiter.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { HealthChecker } from '../../services/health-checker.js';
import type { ActiveRequestTracker } from '../../services/active-requests.js';
import type { ResponseCache } from '../../services/cache.js';
import type { DebugService } from '../../services/debug.js';
import type { DebugCaptureInfo } from '@star-cliproxy/shared';

interface ChatCompletionDeps {
  router: ModelRouter;
  queue: QueueManager;
  rateLimiter: RateLimiter;
  registry: ProviderRegistry;
  healthChecker: HealthChecker;
  validation: ValidationConfig;
  activeRequests: ActiveRequestTracker;
  cache: ResponseCache;
  debug: DebugService;
}

// null byte 제거 (CLI 인젝션 방지)
function sanitizeString(str: string): string {
  return str.replace(/\x00/g, '');
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// 텍스트 블록을 sanitize된 단일 문자열로 평탄화한다.
// 이미지 블록을 만나면 null을 반환하여 호출자가 별도로 처리하도록 한다.
function flattenTextBlock(part: unknown): string | null {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return stringifyUnknown(part);

  const block = part as Record<string, unknown>;
  const type = typeof block.type === 'string' ? block.type : '';

  if (type === 'image_url' || type === 'input_image' || type === 'image') {
    return null;
  }

  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;

  if (Array.isArray(block.content)) {
    return block.content
      .map((item) => flattenTextBlock(item))
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join('\n');
  }

  if (type === 'toolCall') {
    const name = typeof block.name === 'string' ? block.name : 'tool';
    const args = block.arguments ?? block.input ?? block.args;
    return `[Tool call ${name}] ${stringifyUnknown(args)}`.trim();
  }

  if (type === 'toolResult') {
    const name = typeof block.name === 'string' ? block.name : (typeof block.toolName === 'string' ? block.toolName : 'tool');
    const result = block.result ?? block.output ?? block.content ?? block.data;
    return `[Tool result ${name}] ${typeof result === 'string' ? result : stringifyUnknown(result)}`.trim();
  }

  if (type === 'thinking') {
    return typeof block.thinking === 'string' ? `[Thinking] ${block.thinking}` : '';
  }

  if (type === 'input_text' || type === 'text') {
    return typeof block.text === 'string' ? block.text : stringifyUnknown(block);
  }

  return stringifyUnknown(block);
}

// 멀티모달 content를 정규화한다.
// - string: null byte 제거 후 그대로
// - array: 텍스트 블록은 sanitize된 { type: 'text', text } 로, 이미지 블록은 원본 보존
//   (HTTP/OpenAI 호환 vision 모델이 image_url을 그대로 받을 수 있도록)
// - 객체: text 블록 1개로 평탄화
// 인접한 텍스트 블록은 머지하여 LLM이 받기 좋은 형태로 정돈한다.
function normalizeMessageContent(content: unknown): ChatMessageContent {
  if (typeof content === 'string') return sanitizeString(content);

  if (Array.isArray(content)) {
    const out: ChatMessageContentPart[] = [];
    let textBuffer = '';

    const flushText = () => {
      if (textBuffer.length > 0) {
        out.push({ type: 'text', text: sanitizeString(textBuffer) });
        textBuffer = '';
      }
    };

    for (const part of content) {
      if (part && typeof part === 'object' && isImagePart(part as ChatMessageContentPart)) {
        flushText();
        out.push(part as ChatMessageContentPart);
        continue;
      }
      const text = flattenTextBlock(part);
      if (text) {
        if (textBuffer.length > 0) textBuffer += '\n';
        textBuffer += text;
      }
    }
    flushText();

    if (out.length === 0) return '';
    if (out.length === 1 && out[0].type === 'text' && typeof out[0].text === 'string') {
      return out[0].text;
    }
    return out;
  }

  if (content && typeof content === 'object') {
    const text = flattenTextBlock(content);
    return sanitizeString(text ?? '');
  }
  if (content == null) return '';
  return sanitizeString(stringifyUnknown(content));
}

// CLI 에러 메시지에서 내부 정보 제거 (파일 경로, 스택 트레이스 등)
// 클라이언트에 노출되는 에러 응답에만 적용 — 내부 로그는 원본 유지
function sanitizeProviderError(message: string): string {
  return message
    .replace(/\/[\w/.@-]+/g, '[path]')        // 파일/디렉토리 경로 마스킹
    .replace(/at\s+\S+\s*\(.*?\)/g, '')       // 스택 트레이스 제거
    .trim()
    .substring(0, 200);                        // 길이 제한
}

/**
 * 클라이언트 연결 끊김 시 write 에러로 프로세스 크래시 방지
 * destroyed/writableEnded 체크 후 try-catch로 감싸 false 반환
 */
function safeWrite(raw: NodeJS.WritableStream, data: string): boolean {
  try {
    if ((raw as unknown as Record<string, unknown>).destroyed || (raw as unknown as Record<string, unknown>).writableEnded) return false;
    return raw.write(data);
  } catch {
    return false;
  }
}

function makeValidationError(message: string, param?: string) {
  return {
    error: {
      message,
      type: 'invalid_request_error',
      param: param ?? null,
      code: 'invalid_request',
    },
  };
}

export function registerChatCompletionsRoute(
  app: FastifyInstance,
  deps: ChatCompletionDeps,
): void {
  const v = deps.validation;

  app.post<{ Body: ChatCompletionRequest }>(
    '/v1/chat/completions',
    async (request, reply) => {
      const startTime = Date.now();
      const requestId = createRequestId();
      const body = request.body;

      // === 입력 검증 ===

      // 기본 필드 존재 확인
      if (!body.model || !body.messages?.length) {
        return reply.status(400).send(makeValidationError('model and messages are required.'));
      }

      // messages가 배열인지 확인
      if (!Array.isArray(body.messages)) {
        return reply.status(400).send(makeValidationError('messages must be an array.', 'messages'));
      }

      // 메시지 수 제한
      if (body.messages.length > v.maxMessageCount) {
        return reply.status(400).send(makeValidationError(`Too many messages: ${body.messages.length}. Maximum is ${v.maxMessageCount}.`, 'messages'));
      }

      // 메시지별 검증
      let totalPromptLength = 0;
      for (let i = 0; i < body.messages.length; i++) {
        const msg = body.messages[i];

        // role 화이트리스트 검증
        if (!ALLOWED_ROLES.includes(msg.role as typeof ALLOWED_ROLES[number])) {
          return reply.status(400).send(makeValidationError(`Invalid role "${msg.role}" at messages[${i}]. Allowed: ${ALLOWED_ROLES.join(', ')}`, 'messages'));
        }

        // developer → system 정규화 (OpenAI API 호환)
        if (msg.role === 'developer') {
          msg.role = 'system';
        }

        // content를 정규화 (OpenAI content parts + 구조화 블록 허용)
        // 멀티모달 array는 array 형태 그대로 보존 — HTTP provider가 vision 모델로 그대로 패스스루
        const normalizedContent = normalizeMessageContent(msg.content);
        msg.content = normalizedContent;

        // 길이 제한은 텍스트 부분만으로 측정 (base64 image data는 제외 — bodyLimitBytes로 별도 제한)
        const textLength = extractTextFromContent(normalizedContent).length;
        if (textLength > v.maxMessageLength) {
          return reply.status(400).send(makeValidationError(`messages[${i}].content too long: ${textLength} chars. Maximum is ${v.maxMessageLength}.`, 'messages'));
        }

        totalPromptLength += textLength;
      }

      // 전체 프롬프트 총 길이 제한
      if (totalPromptLength > v.maxPromptLength) {
        return reply.status(400).send(makeValidationError(`Total prompt length too long: ${totalPromptLength} chars. Maximum is ${v.maxPromptLength}.`, 'messages'));
      }

      // model명 sanitize
      body.model = sanitizeString(body.model);

      // ADD-06: CLI에서 지원하지 않는 파라미터 감지
      const unsupportedParams: string[] = [];
      if (body.temperature != null) unsupportedParams.push('temperature');
      if (body.max_tokens != null) unsupportedParams.push('max_tokens');
      if ((body as unknown as Record<string, unknown>).top_p != null) unsupportedParams.push('top_p');
      if ((body as unknown as Record<string, unknown>).frequency_penalty != null) unsupportedParams.push('frequency_penalty');
      if ((body as unknown as Record<string, unknown>).presence_penalty != null) unsupportedParams.push('presence_penalty');

      // === 라우팅 ===

      const routes = await deps.router.resolve(body.model);
      if (routes.length === 0) {
        return reply.status(400).send({
          error: {
            message: `Model "${body.model}" not found. Check model mappings.`,
            type: 'invalid_request_error',
            param: 'model',
            code: 'model_not_found',
          },
        });
      }

      // 요청 body의 reasoning_effort가 있으면 화이트리스트 검증 후 model_mapping 값보다 우선 적용
      let bodyReasoningEffort: ReasoningEffort | undefined;
      if (body.reasoning_effort != null) {
        const normalized = typeof body.reasoning_effort === 'string'
          ? body.reasoning_effort.trim().toLowerCase()
          : '';
        if (!isReasoningEffort(normalized)) {
          return reply.status(400).send({
            error: {
              message: 'reasoning_effort must be one of: low, medium, high, xhigh, max.',
              type: 'invalid_request_error',
              param: 'reasoning_effort',
              code: 'invalid_reasoning_effort',
            },
          });
        }
        bodyReasoningEffort = normalized;
      }

      const apiKeyId = (request as unknown as { apiKeyId?: string }).apiKeyId;
      const keyLimits = (request as unknown as { apiKeyRateLimits?: { rpm?: number | null; rpd?: number | null } }).apiKeyRateLimits;
      const clientKey = extractClientKey(request, apiKeyId);

      // === 캐시 조회 (non-streaming만) ===
      const requestHash = !body.stream
        ? deps.cache.generateHash(body.model, body.messages)
        : undefined;

      if (!body.stream && requestHash) {
        const cached = await deps.cache.get(requestHash);
        if (cached) {
          // 캐시 히트: provider 호출 건너뜀
          const cachedBody = JSON.parse(cached.responseBody) as ChatCompletionResponse;

          reply.header('X-Cache', 'HIT');
          reply.header('X-Request-ID', createRequestId());

          logRequest({
            requestId: createRequestId(),
            apiKeyId,
            modelAlias: body.model,
            provider: cached.provider,
            actualModel: routes[0].actualModel,
            reasoningEffort: bodyReasoningEffort ?? routes[0].reasoningEffort,
            status: 'success',
            statusCode: 200,
            promptTokens: cachedBody.usage?.prompt_tokens,
            completionTokens: cachedBody.usage?.completion_tokens,
            totalTokens: cachedBody.usage?.total_tokens,
            latencyMs: Date.now() - startTime,
            isStream: false,
            requestHash,
          });

          return reply.status(200).send(cachedBody);
        }
      }

      // === 폴백 루프 ===

      let lastError: Error | null = null;

      for (const route of routes) {
        const healthy = await deps.healthChecker.isHealthy(route.provider);
        if (!healthy) {
          lastError = new Error(`Provider ${route.provider} is unhealthy`);
          continue;
        }

        const rateResult = deps.rateLimiter.checkAndIncrement(
          apiKeyId ?? 'anonymous',
          route.provider,
          keyLimits,
        );

        if (!rateResult.allowed) {
          reply.header('Retry-After', String(rateResult.retryAfterSeconds ?? 30));
          return reply.status(429).send({
            error: {
              message: `Rate limit exceeded. Retry after ${rateResult.retryAfterSeconds} seconds.`,
              type: 'rate_limit_error',
              param: null,
              code: 'rate_limit_exceeded',
            },
          });
        }

        const provider = deps.registry.get(route.provider);
        if (!provider) {
          lastError = new Error(`Provider ${route.provider} not available`);
          continue;
        }

        // 활성 요청 추적 시작
        deps.activeRequests.start({
          requestId,
          modelAlias: body.model,
          provider: route.provider,
          actualModel: route.actualModel,
          reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
          isStream: body.stream ?? false,
          startedAt: startTime,
        });

        // 디버그 캡처
        const debugEnabled = deps.debug.isEnabled(body.model);
        let debugCapture: DebugCaptureInfo | undefined;
        let debugLogId: string | undefined;
        const onDebug = debugEnabled
          ? (info: DebugCaptureInfo) => { debugCapture = info; }
          : undefined;

        // 요청 시작 시 즉시 디버그 로그 INSERT
        if (debugEnabled) {
          debugLogId = await deps.debug.logStart({
            requestId,
            modelAlias: body.model,
            provider: route.provider,
            actualModel: route.actualModel,
            reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
            isStream: body.stream ?? false,
            requestMessages: body.messages,
          });
        }

        try {
          if (body.stream) {
            // 클라이언트 연결 끊김 감지용 AbortController (큐 외부에서 생성하여 대기 중에도 감지)
            const abortController = new AbortController();
            request.raw.on('close', () => abortController.abort());

            // 스트리밍도 큐를 통해 동시성 제한 적용 (BUG-01 수정)
            await deps.queue.enqueue(route.provider, async () => {
            // 큐 대기 중 클라이언트가 이미 연결을 끊었으면 조기 종료
            if (abortController.signal.aborted) return;

            // 스트리밍 응답
            // reply.raw 직접 쓰기 시 Fastify CORS 미들웨어가 우회되므로 수동 추가
            const origin = request.headers.origin;
            reply.raw.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'X-Request-ID': requestId,
              ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
              ...(routes.indexOf(route) > 0 ? { 'X-Fallback-Provider': route.provider } : {}),
              ...(unsupportedParams.length > 0 ? { 'X-Unsupported-Params': unsupportedParams.join(',') } : {}),
            });

            const roleChunk = formatAsSSE(
              { type: 'delta', content: '' },
              requestId,
              body.model,
            );
            if (roleChunk) safeWrite(reply.raw, roleChunk);

            let totalContent = '';
            let ttfbMs: number | undefined;
            // usage 이벤트에서 실제 토큰 사용량 캡처
            let streamUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

            const streamIterator = provider.executeStream({
              messages: body.messages,
              model: route.actualModel,
              stream: true,
              maxTokens: body.max_tokens,
              temperature: body.temperature,
              signal: abortController.signal,
              onDebug,
              clientKey,
              reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
              providerOverrides: route.providerOverrides,
            });

            try {
              for await (const event of streamIterator) {
                if (!ttfbMs) {
                  ttfbMs = Date.now() - startTime;
                }

                const sseData = formatAsSSE(event, requestId, body.model);
                if (sseData) {
                  // write 실패(연결 끊김)면 스트림 루프 조기 종료
                  if (!safeWrite(reply.raw, sseData)) break;
                }
                if (event.type === 'text_delta') {
                  totalContent += event.text;
                }
                if (event.type === 'usage') {
                  streamUsage = event.usage;
                }

                // 응답 크기 제한
                if (totalContent.length > v.maxResponseLength) {
                  const doneSSE = formatAsSSE({ type: 'done' as const }, requestId, body.model);
                  if (doneSSE) safeWrite(reply.raw, doneSSE);
                  break;
                }
                if (event.type === 'done') break;
              }
            } catch (streamErr) {
              // 헤더 전송 후 에러: 스트림 에러 이벤트 전송 후 종료 (폴백 불가)
              const errMsg = streamErr instanceof Error ? streamErr.message : 'Stream interrupted';
              safeWrite(reply.raw, `data: ${JSON.stringify({ error: { message: errMsg } })}\n\n`);
              safeWrite(reply.raw, 'data: [DONE]\n\n');
              reply.raw.end();

              logRequest({
                requestId,
                apiKeyId,
                modelAlias: body.model,
                provider: route.provider,
                actualModel: route.actualModel,
                reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
                status: 'error',
                statusCode: 200,
                latencyMs: Date.now() - startTime,
                isStream: true,
                errorMessage: errMsg,
              });

              deps.activeRequests.finish(requestId);
              deps.healthChecker.onRequestFailure(route.provider);
              return;
            }

            reply.raw.end();

            const streamLatency = Date.now() - startTime;
            logRequest({
              requestId,
              apiKeyId,
              modelAlias: body.model,
              provider: route.provider,
              actualModel: route.actualModel,
              reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
              status: 'success',
              statusCode: 200,
              // ADD-05: 실제 토큰 수 사용 (없으면 completionTokens만 추정)
              promptTokens: streamUsage?.promptTokens ?? 0,
              completionTokens: streamUsage?.completionTokens ?? Math.ceil(totalContent.length / 4),
              totalTokens: streamUsage?.totalTokens ?? Math.ceil(totalContent.length / 4),
              latencyMs: streamLatency,
              ttfbMs,
              isStream: true,
            });

            if (debugLogId && debugCapture) {
              deps.debug.logComplete(debugLogId, {
                requestId,
                cliArgs: debugCapture.cliArgs,
                streamLines: debugCapture.streamLines,
                httpRequest: debugCapture.httpRequest,
                httpResponse: debugCapture.httpResponse,
                httpStreamLines: debugCapture.httpStreamLines,
                rawResponseText: debugCapture.rawResponseText,
                parsedContent: totalContent,
                tokenUsage: streamUsage,
                status: 'success',
                latencyMs: streamLatency,
              });
            }

            deps.activeRequests.finish(requestId);
            }); // queue.enqueue 끝

            return;
          }

          // Non-streaming 응답
          const result = await deps.queue.enqueue(
            route.provider,
            () => provider.execute({
              messages: body.messages,
              model: route.actualModel,
              stream: false,
              maxTokens: body.max_tokens,
              temperature: body.temperature,
              onDebug,
              clientKey,
              reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
              providerOverrides: route.providerOverrides,
            }),
          );

          // 응답 크기 제한
          let content = result.content;
          if (content.length > v.maxResponseLength) {
            content = content.substring(0, v.maxResponseLength);
          }

          const response: ChatCompletionResponse = {
            id: requestId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: result.finishReason === 'error' ? 'stop' : result.finishReason,
            }],
            usage: {
              prompt_tokens: result.usage.promptTokens,
              completion_tokens: result.usage.completionTokens,
              total_tokens: result.usage.totalTokens,
            },
          };

          if (routes.indexOf(route) > 0) {
            reply.header('X-Fallback-Provider', route.provider);
          }
          reply.header('X-Request-ID', requestId);
          reply.header('X-Cache', 'MISS');
          if (unsupportedParams.length > 0) {
            reply.header('X-Unsupported-Params', unsupportedParams.join(','));
          }
          // codex CLI 세션 재사용 시 thread_id 노출 (참고용). 자동 재사용은 X-Cliproxy-Session-Id 기반.
          if (result.meta?.threadId) {
            reply.header('X-Cliproxy-Thread-Id', result.meta.threadId);
          }

          // 캐시에 응답 저장
          if (requestHash) {
            await deps.cache.set(
              requestHash,
              body.model,
              route.provider,
              JSON.stringify(response),
              result.usage.totalTokens,
            );
          }

          const nonStreamLatency = Date.now() - startTime;
          logRequest({
            requestId,
            apiKeyId,
            modelAlias: body.model,
            provider: route.provider,
            actualModel: route.actualModel,
            reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
            status: 'success',
            statusCode: 200,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
            latencyMs: nonStreamLatency,
            isStream: false,
            requestHash,
          });

          if (debugLogId && debugCapture) {
            deps.debug.logComplete(debugLogId, {
              requestId,
              cliArgs: debugCapture.cliArgs,
              rawStdout: debugCapture.stdout,
              rawStderr: debugCapture.stderr,
              httpRequest: debugCapture.httpRequest,
              httpResponse: debugCapture.httpResponse,
              httpStreamLines: debugCapture.httpStreamLines,
              rawResponseText: debugCapture.rawResponseText,
              parsedContent: content,
              tokenUsage: result.usage,
              status: 'success',
              latencyMs: nonStreamLatency,
            });
          }

          deps.activeRequests.finish(requestId);
          return reply.status(200).send(response);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          const isTimeout = lastError.message.includes('timed out');

          const errLatency = Date.now() - startTime;
          logRequest({
            requestId,
            apiKeyId,
            modelAlias: body.model,
            provider: route.provider,
            actualModel: route.actualModel,
            reasoningEffort: bodyReasoningEffort ?? route.reasoningEffort,
            status: isTimeout ? 'timeout' : 'error',
            statusCode: isTimeout ? 504 : 502,
            latencyMs: errLatency,
            isStream: body.stream ?? false,
            errorMessage: lastError.message,
          });

          if (debugLogId) {
            deps.debug.logComplete(debugLogId, {
              requestId,
              cliArgs: debugCapture?.cliArgs,
              rawStdout: debugCapture?.stdout,
              rawStderr: debugCapture?.stderr,
              streamLines: debugCapture?.streamLines,
              httpRequest: debugCapture?.httpRequest,
              httpResponse: debugCapture?.httpResponse,
              httpStreamLines: debugCapture?.httpStreamLines,
              rawResponseText: debugCapture?.rawResponseText,
              status: isTimeout ? 'timeout' : 'error',
              latencyMs: errLatency,
              errorMessage: lastError.message,
            });
          }

          deps.activeRequests.finish(requestId);
          deps.healthChecker.onRequestFailure(route.provider);
          continue;
        }
      }

      // ADD-03: 타임아웃 여부에 따라 504/502 구분
      const isTimeout = lastError?.message.includes('timed out') ?? false;
      const statusCode = isTimeout ? 504 : 502;

      return reply.status(statusCode).send({
        error: {
          message: `All providers failed for model "${body.model}". Last error: ${sanitizeProviderError(lastError?.message ?? 'unknown')}`,
          type: isTimeout ? 'timeout_error' : 'provider_error',
          param: null,
          code: isTimeout ? 'timeout' : 'provider_error',
        },
      });
    },
  );
}
