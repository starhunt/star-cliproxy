import type { FastifyInstance } from 'fastify';
import type { RerankRequest, RerankResponse, DebugCaptureInfo, RerankOptions, RerankResult } from '@star-cliproxy/shared';
import { createRequestId } from '../../utils/stream-transformer.js';
import { logRequest } from '../../middleware/request-logger.js';
import type { ModelRouter } from '../../services/router.js';
import type { QueueManager } from '../../services/queue.js';
import type { RateLimiter } from '../../middleware/rate-limiter.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { HealthChecker } from '../../services/health-checker.js';
import type { ActiveRequestTracker } from '../../services/active-requests.js';
import type { DebugService } from '../../services/debug.js';

interface RerankDeps {
  router: ModelRouter;
  queue: QueueManager;
  rateLimiter: RateLimiter;
  registry: ProviderRegistry;
  healthChecker: HealthChecker;
  activeRequests: ActiveRequestTracker;
  debug: DebugService;
}

// 에러 메시지에서 내부 경로/스택 제거
function sanitizeProviderError(message: string): string {
  return message
    .replace(/\/[\w/.@-]+/g, '[path]')
    .replace(/at\s+\S+\s*\(.*?\)/g, '')
    .trim()
    .substring(0, 200);
}

// executeRerank 메서드를 보유한 프로바이더만 허용 (HttpProvider 전용 덕 타이핑)
interface RerankCapableProvider {
  executeRerank(options: RerankOptions): Promise<RerankResult>;
}

function hasExecuteRerank(provider: unknown): provider is RerankCapableProvider {
  return typeof (provider as { executeRerank?: unknown })?.executeRerank === 'function';
}

export function registerRerankRoute(
  app: FastifyInstance,
  deps: RerankDeps,
): void {
  app.post<{ Body: RerankRequest }>(
    '/v1/rerank',
    async (request, reply) => {
      const startTime = Date.now();
      const requestId = createRequestId();
      const body = request.body;

      // 입력 검증
      if (!body.model || !body.query || !Array.isArray(body.documents)) {
        return reply.status(400).send({
          error: {
            message: 'model, query, and documents (array) are required.',
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_request',
          },
        });
      }

      if (body.documents.length === 0 || body.documents.some((d) => typeof d !== 'string')) {
        return reply.status(400).send({
          error: {
            message: 'documents must be a non-empty array of strings.',
            type: 'invalid_request_error',
            param: 'documents',
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

      // === 레이트 리밋: 글로벌/키 단위는 요청당 1회만 차감 (폴백 루프 진입 전) ===
      const gkResult = deps.rateLimiter.checkGlobalAndKey(apiKeyId ?? 'anonymous', keyLimits);
      if (!gkResult.allowed) {
        reply.header('Retry-After', String(gkResult.retryAfterSeconds ?? 30));
        return reply.status(429).send({
          error: {
            message: `Rate limit exceeded. Retry after ${gkResult.retryAfterSeconds} seconds.`,
            type: 'rate_limit_error',
            param: null,
            code: 'rate_limit_exceeded',
          },
        });
      }

      let lastError: Error | null = null;
      let rateLimitRetryAfter: number | null = null;

      for (const route of routes) {
        const healthy = await deps.healthChecker.isHealthy(route.provider);
        if (!healthy) {
          lastError = new Error(`Provider ${route.provider} is unhealthy`);
          continue;
        }

        // 프로바이더 단위 한도는 시도하는 프로바이더별로 차감. 초과 시 다음 프로바이더로 폴백.
        const provRate = deps.rateLimiter.checkProvider(route.provider);
        if (!provRate.allowed) {
          rateLimitRetryAfter = provRate.retryAfterSeconds ?? 30;
          lastError = new Error(`Provider ${route.provider} rate limit exceeded`);
          continue;
        }

        const provider = deps.registry.get(route.provider);
        if (!provider) {
          lastError = new Error(`Provider ${route.provider} not available`);
          continue;
        }

        // rerank 지원 여부 확인 (HttpProvider만 endpointTypes에 'rerank' 포함)
        if (!provider.endpointTypes.includes('rerank') || !hasExecuteRerank(provider)) {
          lastError = new Error(`Provider ${route.provider} does not support rerank`);
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
            requestMessages: [{ role: 'user', content: `[rerank] query="${body.query}" docs=${body.documents.length}` }],
          });
        }

        try {
          const rerankProvider = provider as unknown as RerankCapableProvider;
          const result = await deps.queue.enqueue(
            route.provider,
            () => rerankProvider.executeRerank({
              model: route.actualModel,
              query: body.query,
              documents: body.documents,
              topN: body.top_n,
              returnDocuments: body.return_documents,
              signal: request.raw.destroyed ? AbortSignal.abort() : undefined,
              onDebug,
              providerOverrides: route.providerOverrides,
            }),
          );

          const latencyMs = Date.now() - startTime;

          const rerankResponse: RerankResponse = {
            id: requestId,
            results: result.results.map((item) => ({
              index: item.index,
              relevance_score: item.relevanceScore,
              ...(item.document !== undefined ? { document: { text: item.document } } : {}),
            })),
            model: result.model,
            usage: {
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
            promptTokens: 0,
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
              parsedContent: `[rerank ${result.results.length} result(s)]`,
              tokenUsage: {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: result.usage.totalTokens,
              },
              status: 'success',
              latencyMs,
            });
          }

          deps.activeRequests.finish(requestId);
          return reply.status(200).send(rerankResponse);
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

      // 모든 provider가 프로바이더 단위 한도로 소진되었으면 502 대신 429 반환.
      if (rateLimitRetryAfter !== null) {
        reply.header('Retry-After', String(rateLimitRetryAfter));
        return reply.status(429).send({
          error: {
            message: `Rate limit exceeded. Retry after ${rateLimitRetryAfter} seconds.`,
            type: 'rate_limit_error',
            param: null,
            code: 'rate_limit_exceeded',
          },
        });
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
