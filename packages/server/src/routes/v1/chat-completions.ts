import type { FastifyInstance } from 'fastify';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderName,
  ValidationConfig,
} from '@star-cliproxy/shared';
import { ALLOWED_ROLES } from '@star-cliproxy/shared';
import { createRequestId, formatAsSSE } from '../../utils/stream-transformer.js';
import { logRequest } from '../../middleware/request-logger.js';
import type { ModelRouter } from '../../services/router.js';
import type { QueueManager } from '../../services/queue.js';
import type { RateLimiter } from '../../middleware/rate-limiter.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { HealthChecker } from '../../services/health-checker.js';
import type { ActiveRequestTracker } from '../../services/active-requests.js';
import type { ResponseCache } from '../../services/cache.js';

interface ChatCompletionDeps {
  router: ModelRouter;
  queue: QueueManager;
  rateLimiter: RateLimiter;
  registry: ProviderRegistry;
  healthChecker: HealthChecker;
  validation: ValidationConfig;
  activeRequests: ActiveRequestTracker;
  cache: ResponseCache;
}

// null byte 제거 (CLI 인젝션 방지)
function sanitizeString(str: string): string {
  return str.replace(/\x00/g, '');
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

        // content 타입 검증
        if (typeof msg.content !== 'string') {
          return reply.status(400).send(makeValidationError(`messages[${i}].content must be a string.`, 'messages'));
        }

        // null byte 제거
        msg.content = sanitizeString(msg.content);

        // 개별 메시지 길이 제한
        if (msg.content.length > v.maxMessageLength) {
          return reply.status(400).send(makeValidationError(`messages[${i}].content too long: ${msg.content.length} chars. Maximum is ${v.maxMessageLength}.`, 'messages'));
        }

        totalPromptLength += msg.content.length;
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

      const apiKeyId = (request as unknown as { apiKeyId?: string }).apiKeyId;
      const keyLimits = (request as unknown as { apiKeyRateLimits?: { rpm?: number | null; rpd?: number | null } }).apiKeyRateLimits;

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
          isStream: body.stream ?? false,
          startedAt: startTime,
        });

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
            reply.raw.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'X-Request-ID': requestId,
              ...(routes.indexOf(route) > 0 ? { 'X-Fallback-Provider': route.provider } : {}),
              ...(unsupportedParams.length > 0 ? { 'X-Unsupported-Params': unsupportedParams.join(',') } : {}),
            });

            const roleChunk = formatAsSSE(
              { type: 'delta', content: '' },
              requestId,
              body.model,
            );
            if (roleChunk) reply.raw.write(roleChunk);

            let totalContent = '';
            let ttfbMs: number | undefined;
            // done 청크에서 실제 토큰 사용량 캡처 (ADD-05)
            let streamUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

            const streamIterator = provider.executeStream({
              messages: body.messages,
              model: route.actualModel,
              stream: true,
              maxTokens: body.max_tokens,
              temperature: body.temperature,
              signal: abortController.signal,
            });

            try {
              for await (const chunk of streamIterator) {
                if (!ttfbMs) {
                  ttfbMs = Date.now() - startTime;
                }

                const sseData = formatAsSSE(chunk, requestId, body.model);
                if (sseData) {
                  reply.raw.write(sseData);
                }
                if (chunk.type === 'delta' && chunk.content) {
                  totalContent += chunk.content;
                }
                if (chunk.type === 'done' && chunk.usage) {
                  streamUsage = chunk.usage;
                }

                // 응답 크기 제한
                if (totalContent.length > v.maxResponseLength) {
                  const doneSSE = formatAsSSE({ type: 'done' }, requestId, body.model);
                  if (doneSSE) reply.raw.write(doneSSE);
                  break;
              }
              }
            } catch (streamErr) {
              // 헤더 전송 후 에러: 스트림 에러 이벤트 전송 후 종료 (폴백 불가)
              const errMsg = streamErr instanceof Error ? streamErr.message : 'Stream interrupted';
              reply.raw.write(`data: ${JSON.stringify({ error: { message: errMsg } })}\n\n`);
              reply.raw.write('data: [DONE]\n\n');
              reply.raw.end();

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
              return;
            }

            reply.raw.end();

            logRequest({
              requestId,
              apiKeyId,
              modelAlias: body.model,
              provider: route.provider,
              actualModel: route.actualModel,
              status: 'success',
              statusCode: 200,
              // ADD-05: 실제 토큰 수 사용 (없으면 추정)
              promptTokens: streamUsage?.promptTokens,
              completionTokens: streamUsage?.completionTokens ?? Math.ceil(totalContent.length / 4),
              totalTokens: streamUsage?.totalTokens,
              latencyMs: Date.now() - startTime,
              ttfbMs,
              isStream: true,
            });

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
            latencyMs: Date.now() - startTime,
            isStream: false,
            requestHash,
          });

          deps.activeRequests.finish(requestId);
          return reply.status(200).send(response);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          const isTimeout = lastError.message.includes('timed out');

          logRequest({
            requestId,
            apiKeyId,
            modelAlias: body.model,
            provider: route.provider,
            actualModel: route.actualModel,
            status: isTimeout ? 'timeout' : 'error',
            statusCode: isTimeout ? 504 : 502, // ADD-03: 타임아웃은 504 반환
            latencyMs: Date.now() - startTime,
            isStream: body.stream ?? false,
            errorMessage: lastError.message,
          });

          deps.activeRequests.finish(requestId);
          continue;
        }
      }

      // ADD-03: 타임아웃 여부에 따라 504/502 구분
      const isTimeout = lastError?.message.includes('timed out') ?? false;
      const statusCode = isTimeout ? 504 : 502;

      return reply.status(statusCode).send({
        error: {
          message: `All providers failed for model "${body.model}". Last error: ${lastError?.message ?? 'unknown'}`,
          type: isTimeout ? 'timeout_error' : 'provider_error',
          param: null,
          code: isTimeout ? 'timeout' : 'provider_error',
        },
      });
    },
  );
}
