import type { FastifyInstance } from 'fastify';
import type { ValidationConfig } from '@star-cliproxy/shared';
import { nanoid } from 'nanoid';
import { createRequestId } from '../../utils/stream-transformer.js';
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

interface MessagesDeps {
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

// Anthropic 요청 타입
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
}

interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text: string }>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: unknown[];
  tool_choice?: unknown;
  thinking?: unknown;
  metadata?: unknown;
}

// null byte 제거 (CLI 인젝션 방지)
function sanitizeString(str: string): string {
  return str.replace(/\x00/g, '');
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

// Anthropic 에러 응답 형식
function makeAnthropicError(type: string, message: string) {
  return {
    type: 'error',
    error: { type, message },
  };
}

// finishReason 변환 (내부 → Anthropic)
function toAnthropicStopReason(finishReason: string): string {
  switch (finishReason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    default: return 'end_turn';
  }
}

// Anthropic content를 string으로 정규화
function normalizeContent(content: string | Array<{ type: string; text?: string; [key: string]: unknown }>): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n');
  }
  return '';
}

// system 필드를 string으로 정규화
function normalizeSystem(system: string | Array<{ type: string; text: string }>): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }
  return '';
}

/**
 * Anthropic SSE 이벤트 작성 헬퍼
 * 클라이언트 연결 끊김 시 write 에러로 프로세스 크래시 방지:
 * destroyed/writableEnded 체크 + try-catch 적용
 * @returns 쓰기 성공 여부 (false = 연결 끊김)
 */
function writeSSE(raw: NodeJS.WritableStream, event: string, data: unknown): boolean {
  try {
    if ((raw as unknown as Record<string, unknown>).destroyed || (raw as unknown as Record<string, unknown>).writableEnded) return false;
    return raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    return false;
  }
}

// 메시지 ID 생성
function createMessageId(): string {
  return `msg_${nanoid(24)}`;
}

export function registerMessagesRoute(
  app: FastifyInstance,
  deps: MessagesDeps,
): void {
  const v = deps.validation;

  app.post<{ Body: AnthropicMessagesRequest }>(
    '/v1/messages',
    async (request, reply) => {
      const startTime = Date.now();
      const requestId = createRequestId();
      const messageId = createMessageId();
      const body = request.body;

      // === 입력 검증 ===

      if (!body.model) {
        return reply.status(400).send(makeAnthropicError('invalid_request_error', 'model is required.'));
      }

      if (!body.messages?.length) {
        return reply.status(400).send(makeAnthropicError('invalid_request_error', 'messages is required and must not be empty.'));
      }

      if (!Array.isArray(body.messages)) {
        return reply.status(400).send(makeAnthropicError('invalid_request_error', 'messages must be an array.'));
      }

      if (body.max_tokens == null) {
        return reply.status(400).send(makeAnthropicError('invalid_request_error', 'max_tokens is required.'));
      }

      // 메시지 수 제한
      if (body.messages.length > v.maxMessageCount) {
        return reply.status(400).send(makeAnthropicError('invalid_request_error', `Too many messages: ${body.messages.length}. Maximum is ${v.maxMessageCount}.`));
      }

      // === 요청 변환 (Anthropic → 내부) ===

      // 내부 메시지 배열 구성
      const internalMessages: Array<{ role: 'system' | 'user' | 'assistant' | 'developer'; content: string }> = [];

      // system 필드 → messages 배열 맨 앞에 삽입
      if (body.system) {
        const systemContent = sanitizeString(normalizeSystem(body.system));
        if (systemContent) {
          internalMessages.push({ role: 'system', content: systemContent });
        }
      }

      // messages 변환 + 검증
      let totalPromptLength = 0;
      for (let i = 0; i < body.messages.length; i++) {
        const msg = body.messages[i];

        // role 검증: Anthropic은 user, assistant만 허용
        if (msg.role !== 'user' && msg.role !== 'assistant') {
          return reply.status(400).send(makeAnthropicError('invalid_request_error', `Invalid role "${msg.role}" at messages[${i}]. Allowed: user, assistant`));
        }

        // content 정규화
        let content = normalizeContent(msg.content);
        content = sanitizeString(content);

        // 개별 메시지 길이 제한
        if (content.length > v.maxMessageLength) {
          return reply.status(400).send(makeAnthropicError('invalid_request_error', `messages[${i}].content too long: ${content.length} chars. Maximum is ${v.maxMessageLength}.`));
        }

        totalPromptLength += content.length;
        internalMessages.push({ role: msg.role, content });
      }

      // 전체 프롬프트 총 길이 제한
      if (totalPromptLength > v.maxPromptLength) {
        return reply.status(400).send(makeAnthropicError('invalid_request_error', `Total prompt length too long: ${totalPromptLength} chars. Maximum is ${v.maxPromptLength}.`));
      }

      // model명 sanitize
      body.model = sanitizeString(body.model);

      // 미지원 파라미터 감지
      const unsupportedParams: string[] = [];
      if (body.temperature != null) unsupportedParams.push('temperature');
      if (body.top_p != null) unsupportedParams.push('top_p');
      if (body.top_k != null) unsupportedParams.push('top_k');
      if (body.stop_sequences != null) unsupportedParams.push('stop_sequences');
      if (body.tools != null) unsupportedParams.push('tools');
      if (body.tool_choice != null) unsupportedParams.push('tool_choice');
      if (body.thinking != null) unsupportedParams.push('thinking');
      if (body.metadata != null) unsupportedParams.push('metadata');

      // === 라우팅 ===

      const routes = await deps.router.resolve(body.model);
      if (routes.length === 0) {
        return reply.status(400).send(makeAnthropicError('invalid_request_error', `Model "${body.model}" not found. Check model mappings.`));
      }

      const apiKeyId = (request as unknown as { apiKeyId?: string }).apiKeyId;
      const keyLimits = (request as unknown as { apiKeyRateLimits?: { rpm?: number | null; rpd?: number | null } }).apiKeyRateLimits;

      // === 캐시 조회 (non-streaming만) ===
      const requestHash = !body.stream
        ? deps.cache.generateHash(body.model, internalMessages)
        : undefined;

      if (!body.stream && requestHash) {
        const cached = await deps.cache.get(requestHash);
        if (cached) {
          const cachedBody = JSON.parse(cached.responseBody);

          reply.header('X-Cache', 'HIT');
          reply.header('X-Request-ID', requestId);

          logRequest({
            requestId,
            apiKeyId,
            modelAlias: body.model,
            provider: cached.provider,
            actualModel: routes[0].actualModel,
            status: 'success',
            statusCode: 200,
            promptTokens: cachedBody.usage?.input_tokens,
            completionTokens: cachedBody.usage?.output_tokens,
            totalTokens: (cachedBody.usage?.input_tokens ?? 0) + (cachedBody.usage?.output_tokens ?? 0),
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
          return reply.status(429).send(makeAnthropicError('rate_limit_error', `Rate limit exceeded. Retry after ${rateResult.retryAfterSeconds} seconds.`));
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

        if (debugEnabled) {
          debugLogId = await deps.debug.logStart({
            requestId,
            modelAlias: body.model,
            provider: route.provider,
            actualModel: route.actualModel,
            isStream: body.stream ?? false,
            requestMessages: internalMessages,
          });
        }

        try {
          if (body.stream) {
            // 클라이언트 연결 끊김 감지용 AbortController
            const abortController = new AbortController();
            request.raw.on('close', () => abortController.abort());

            await deps.queue.enqueue(route.provider, async () => {
              // 큐 대기 중 클라이언트가 이미 연결을 끊었으면 조기 종료
              if (abortController.signal.aborted) return;

              // Anthropic SSE 스트리밍 응답
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

              // message_start 이벤트 (연결 끊김이면 조기 종료)
              if (!writeSSE(reply.raw, 'message_start', {
                type: 'message_start',
                message: {
                  id: messageId,
                  type: 'message',
                  role: 'assistant',
                  content: [],
                  model: body.model,
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 0, output_tokens: 1 },
                },
              })) return;

              // content_block_start 이벤트
              if (!writeSSE(reply.raw, 'content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
              })) return;

              // ping 이벤트
              writeSSE(reply.raw, 'ping', { type: 'ping' });

              let totalContent = '';
              let ttfbMs: number | undefined;
              let streamUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

              const streamIterator = provider.executeStream({
                messages: internalMessages,
                model: route.actualModel,
                stream: true,
                maxTokens: body.max_tokens,
                temperature: body.temperature,
                signal: abortController.signal,
                onDebug,
                clientKey: apiKeyId,
              });

              try {
                for await (const chunk of streamIterator) {
                  if (!ttfbMs) {
                    ttfbMs = Date.now() - startTime;
                  }

                  if (chunk.type === 'delta' && chunk.content) {
                    // content_block_delta 이벤트 (write 실패 = 연결 끊김 → 루프 조기 종료)
                    if (!writeSSE(reply.raw, 'content_block_delta', {
                      type: 'content_block_delta',
                      index: 0,
                      delta: { type: 'text_delta', text: chunk.content },
                    })) break;
                    totalContent += chunk.content;
                  }

                  if (chunk.type === 'done' && chunk.usage) {
                    streamUsage = chunk.usage;
                  }

                  // 응답 크기 제한
                  if (totalContent.length > v.maxResponseLength) {
                    break;
                  }
                }
              } catch (streamErr) {
                // 헤더 전송 후 에러: 스트림 에러 이벤트 전송 후 종료
                const errMsg = streamErr instanceof Error ? streamErr.message : 'Stream interrupted';
                writeSSE(reply.raw, 'error', makeAnthropicError('api_error', errMsg));
                reply.raw.end();  // end()는 이미 destroyed 체크를 내부적으로 처리

                logRequest({
                  requestId,
                  apiKeyId,
                  modelAlias: body.model,
                  provider: route.provider,
                  actualModel: route.actualModel,
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

              // content_block_stop 이벤트
              writeSSE(reply.raw, 'content_block_stop', {
                type: 'content_block_stop',
                index: 0,
              });

              // message_delta 이벤트 (연결 끊김이면 이후 쓰기 시도하지 않음)
              if (!writeSSE(reply.raw, 'message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: streamUsage?.completionTokens ?? Math.ceil(totalContent.length / 4) },
              })) {
                reply.raw.end();
              } else {
                // message_stop 이벤트
                writeSSE(reply.raw, 'message_stop', { type: 'message_stop' });
                reply.raw.end();
              }

              const streamLatency = Date.now() - startTime;
              logRequest({
                requestId,
                apiKeyId,
                modelAlias: body.model,
                provider: route.provider,
                actualModel: route.actualModel,
                status: 'success',
                statusCode: 200,
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
              messages: internalMessages,
              model: route.actualModel,
              stream: false,
              maxTokens: body.max_tokens,
              temperature: body.temperature,
              onDebug,
              clientKey: apiKeyId,
            }),
          );

          // 응답 크기 제한
          let content = result.content;
          if (content.length > v.maxResponseLength) {
            content = content.substring(0, v.maxResponseLength);
          }

          // Anthropic 형식 응답 생성
          const response = {
            id: messageId,
            type: 'message' as const,
            role: 'assistant' as const,
            content: [{ type: 'text', text: content }],
            model: body.model,
            stop_reason: toAnthropicStopReason(result.finishReason === 'error' ? 'stop' : result.finishReason),
            stop_sequence: null,
            usage: {
              input_tokens: result.usage.promptTokens,
              output_tokens: result.usage.completionTokens,
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

      // 모든 프로바이더 실패
      const isTimeout = lastError?.message.includes('timed out') ?? false;
      const statusCode = isTimeout ? 504 : 502;
      const errorType = isTimeout ? 'timeout_error' : 'api_error';

      return reply.status(statusCode).send(makeAnthropicError(errorType, `All providers failed for model "${body.model}". Last error: ${sanitizeProviderError(lastError?.message ?? 'unknown')}`));
    },
  );
}
