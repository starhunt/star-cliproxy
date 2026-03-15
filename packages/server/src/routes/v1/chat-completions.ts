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

interface ChatCompletionDeps {
  router: ModelRouter;
  queue: QueueManager;
  rateLimiter: RateLimiter;
  registry: ProviderRegistry;
  healthChecker: HealthChecker;
  validation: ValidationConfig;
  activeRequests: ActiveRequestTracker;
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
            // 스트리밍 응답
            reply.raw.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'X-Request-ID': requestId,
              ...(routes.indexOf(route) > 0 ? { 'X-Fallback-Provider': route.provider } : {}),
            });

            const roleChunk = formatAsSSE(
              { type: 'delta', content: '' },
              requestId,
              body.model,
            );
            if (roleChunk) reply.raw.write(roleChunk);

            let totalContent = '';
            let ttfbMs: number | undefined;

            const streamIterator = provider.executeStream({
              messages: body.messages,
              model: route.actualModel,
              stream: true,
              maxTokens: body.max_tokens,
              temperature: body.temperature,
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
              completionTokens: Math.ceil(totalContent.length / 4),
              latencyMs: Date.now() - startTime,
              ttfbMs,
              isStream: true,
            });

            deps.activeRequests.finish(requestId);
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
          });

          deps.activeRequests.finish(requestId);
          return reply.status(200).send(response);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));

          logRequest({
            requestId,
            apiKeyId,
            modelAlias: body.model,
            provider: route.provider,
            actualModel: route.actualModel,
            status: lastError.message.includes('timed out') ? 'timeout' : 'error',
            statusCode: 502,
            latencyMs: Date.now() - startTime,
            isStream: body.stream ?? false,
            errorMessage: lastError.message,
          });

          deps.activeRequests.finish(requestId);
          continue;
        }
      }

      return reply.status(502).send({
        error: {
          message: `All providers failed for model "${body.model}". Last error: ${lastError?.message ?? 'unknown'}`,
          type: 'provider_error',
          param: null,
          code: 'provider_error',
        },
      });
    },
  );
}
