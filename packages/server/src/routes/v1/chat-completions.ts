import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderName,
} from '@star-cliproxy/shared';
import { createRequestId, formatAsSSE } from '../../utils/stream-transformer.js';
import { logRequest, type LogEntry } from '../../middleware/request-logger.js';
import type { ModelRouter } from '../../services/router.js';
import type { QueueManager } from '../../services/queue.js';
import type { RateLimiter } from '../../middleware/rate-limiter.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { HealthChecker } from '../../services/health-checker.js';

interface ChatCompletionDeps {
  router: ModelRouter;
  queue: QueueManager;
  rateLimiter: RateLimiter;
  registry: ProviderRegistry;
  healthChecker: HealthChecker;
}

export function registerChatCompletionsRoute(
  app: FastifyInstance,
  deps: ChatCompletionDeps,
): void {
  app.post<{ Body: ChatCompletionRequest }>(
    '/v1/chat/completions',
    async (request, reply) => {
      const startTime = Date.now();
      const requestId = createRequestId();
      const body = request.body;

      // 요청 검증
      if (!body.model || !body.messages?.length) {
        return reply.status(400).send({
          error: {
            message: 'model and messages are required.',
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_request',
          },
        });
      }

      // 모델 라우팅 (폴백 포함)
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

      // 요청 정보 추출
      const apiKeyId = (request as unknown as { apiKeyId?: string }).apiKeyId;
      const keyLimits = (request as unknown as { apiKeyRateLimits?: { rpm?: number | null; rpd?: number | null } }).apiKeyRateLimits;

      // 폴백 루프: priority 순으로 시도
      let lastError: Error | null = null;
      let usedProvider: ProviderName | null = null;
      let usedModel: string | null = null;

      for (const route of routes) {
        // 건강 체크
        const healthy = await deps.healthChecker.isHealthy(route.provider);
        if (!healthy) {
          lastError = new Error(`Provider ${route.provider} is unhealthy`);
          continue;
        }

        // 레이트 리밋 체크
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

        usedProvider = route.provider;
        usedModel = route.actualModel;

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

            // 첫 번째 chunk: role
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
            }

            reply.raw.end();

            // 로그 기록
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

          const response: ChatCompletionResponse = {
            id: requestId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: result.content },
              finish_reason: result.finishReason === 'error' ? 'stop' : result.finishReason,
            }],
            usage: {
              prompt_tokens: result.usage.promptTokens,
              completion_tokens: result.usage.completionTokens,
              total_tokens: result.usage.totalTokens,
            },
          };

          // 폴백 사용 시 헤더 추가
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

          // 다음 폴백 시도
          continue;
        }
      }

      // 모든 provider 실패
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
