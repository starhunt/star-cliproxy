import type { FastifyInstance } from 'fastify';
import type { ImageGenerationRequest, ImageGenerationResponse, DebugCaptureInfo } from '@star-cliproxy/shared';
import { createRequestId } from '../../utils/stream-transformer.js';
import { logRequest } from '../../middleware/request-logger.js';
import type { ModelRouter } from '../../services/router.js';
import type { QueueManager } from '../../services/queue.js';
import type { RateLimiter } from '../../middleware/rate-limiter.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { HealthChecker } from '../../services/health-checker.js';
import type { ActiveRequestTracker } from '../../services/active-requests.js';
import type { DebugService } from '../../services/debug.js';

interface ImageGenerationDeps {
  router: ModelRouter;
  queue: QueueManager;
  rateLimiter: RateLimiter;
  registry: ProviderRegistry;
  healthChecker: HealthChecker;
  activeRequests: ActiveRequestTracker;
  debug: DebugService;
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

export function registerImageGenerationsRoute(
  app: FastifyInstance,
  deps: ImageGenerationDeps,
): void {
  app.post<{ Body: ImageGenerationRequest }>(
    '/v1/images/generations',
    async (request, reply) => {
      const startTime = Date.now();
      const requestId = createRequestId();
      const body = request.body;

      // 입력 검증
      if (!body.model || !body.prompt) {
        return reply.status(400).send({
          error: {
            message: 'model and prompt are required.',
            type: 'invalid_request_error',
            param: null,
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
            requestMessages: [{ role: 'user', content: body.prompt }],
          });
        }

        try {
          const result = await deps.queue.enqueue(
            route.provider,
            () => provider.execute({
              messages: [{ role: 'user', content: body.prompt }],
              model: route.actualModel,
              stream: false,
              onDebug,
            }),
          );

          const latencyMs = Date.now() - startTime;

          // 프로바이더 응답에서 OpenAI 이미지 형식 추출
          let imageResponse: ImageGenerationResponse;
          try {
            const parsed = JSON.parse(result.content);
            if (parsed.data && Array.isArray(parsed.data)) {
              imageResponse = parsed;
            } else {
              throw new Error('not openai format');
            }
          } catch {
            imageResponse = {
              created: Math.floor(Date.now() / 1000),
              data: [{ url: result.content }],
            };
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
            latencyMs,
            isStream: false,
          });

          if (debugLogId) {
            deps.debug.logComplete(debugLogId, {
              requestId,
              cliArgs: debugCapture?.cliArgs,
              rawStdout: debugCapture?.stdout,
              rawStderr: debugCapture?.stderr,
              parsedContent: imageResponse.data?.[0]?.url ?? result.content,
              tokenUsage: result.usage,
              status: 'success',
              latencyMs,
            });
          }

          deps.activeRequests.finish(requestId);
          return reply.status(200).send(imageResponse);
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
