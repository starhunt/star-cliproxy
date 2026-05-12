import type { FastifyInstance } from 'fastify';
import type { EmbeddingRequest, EmbeddingResponse, DebugCaptureInfo } from '@star-cliproxy/shared';
import { createRequestId } from '../../utils/stream-transformer.js';
import { logRequest } from '../../middleware/request-logger.js';
import type { ModelRouter } from '../../services/router.js';
import type { QueueManager } from '../../services/queue.js';
import type { RateLimiter } from '../../middleware/rate-limiter.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { HealthChecker } from '../../services/health-checker.js';
import type { ActiveRequestTracker } from '../../services/active-requests.js';
import type { DebugService } from '../../services/debug.js';

interface EmbeddingDeps {
  router: ModelRouter;
  queue: QueueManager;
  rateLimiter: RateLimiter;
  registry: ProviderRegistry;
  healthChecker: HealthChecker;
  activeRequests: ActiveRequestTracker;
  debug: DebugService;
}

// CLI 에러 메시지에서 내부 정보 제거
function sanitizeProviderError(message: string): string {
  return message
    .replace(/\/[\w/.@-]+/g, '[path]')
    .replace(/at\s+\S+\s*\(.*?\)/g, '')
    .trim()
    .substring(0, 200);
}

export function registerEmbeddingsRoute(
  app: FastifyInstance,
  deps: EmbeddingDeps,
): void {
  app.post<{ Body: EmbeddingRequest }>(
    '/v1/embeddings',
    async (request, reply) => {
      const startTime = Date.now();
      const requestId = createRequestId();
      const body = request.body;

      // 입력 검증
      if (!body.model || !body.input) {
        return reply.status(400).send({
          error: {
            message: 'model and input are required.',
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_request',
          },
        });
      }

      // input 정규화: 문자열이면 배열로
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      if (inputs.length === 0 || inputs.some(i => typeof i !== 'string')) {
        return reply.status(400).send({
          error: {
            message: 'input must be a non-empty string or array of strings.',
            type: 'invalid_request_error',
            param: 'input',
            code: 'invalid_request',
          },
        });
      }

      // 라우팅
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

        // 임베딩 지원 여부 확인
        if (!provider.endpointTypes.includes('embeddings')) {
          lastError = new Error(`Provider ${route.provider} does not support embeddings`);
          continue;
        }

        deps.activeRequests.start({
          requestId,
          modelAlias: body.model,
          provider: route.provider,
          actualModel: route.actualModel,
          isStream: false,
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
            isStream: false,
            requestMessages: [{ role: 'user', content: Array.isArray(body.input) ? body.input.join('\n') : body.input }],
          });
        }

        try {
          const result = await deps.queue.enqueue(
            route.provider,
            () => provider.executeEmbedding({
              model: route.actualModel,
              input: body.input,
              encodingFormat: body.encoding_format,
              dimensions: body.dimensions,
              signal: request.raw.destroyed ? AbortSignal.abort() : undefined,
              onDebug,
              // 임베딩은 stateless이나 일관성을 위해 overrides 전달 (HTTP provider extra_args 등에 활용 가능)
              providerOverrides: route.providerOverrides,
            }),
          );

          const latencyMs = Date.now() - startTime;

          const embeddingResponse: EmbeddingResponse = {
            object: 'list',
            data: result.embeddings.map((embedding, index) => ({
              object: 'embedding' as const,
              embedding,
              index,
            })),
            model: result.model,
            usage: {
              prompt_tokens: result.usage.promptTokens,
              total_tokens: result.usage.totalTokens,
            },
          };

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
            completionTokens: 0,
            totalTokens: result.usage.totalTokens,
            latencyMs,
            isStream: false,
          });

          if (debugLogId) {
            deps.debug.logComplete(debugLogId, {
              requestId,
              cliArgs: debugCapture?.cliArgs,
              rawStdout: debugCapture?.stdout,
              rawStderr: debugCapture?.stderr,
              rawResponseText: debugCapture?.rawResponseText,
              parsedContent: `[${result.embeddings.length} embedding(s), dim=${result.embeddings[0]?.length ?? 0}]`,
              tokenUsage: {
                promptTokens: result.usage.promptTokens,
                completionTokens: 0,
                totalTokens: result.usage.totalTokens,
              },
              status: 'success',
              latencyMs,
            });
          }

          deps.activeRequests.finish(requestId);
          return reply.status(200).send(embeddingResponse);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          const isTimeout = lastError.message.includes('timed out') || lastError.message.includes('504');
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
            isStream: false,
            errorMessage: lastError.message,
          });

          if (debugLogId) {
            deps.debug.logComplete(debugLogId, {
              requestId,
              cliArgs: debugCapture?.cliArgs,
              rawStdout: debugCapture?.stdout,
              rawStderr: debugCapture?.stderr,
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
