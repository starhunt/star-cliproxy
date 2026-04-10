import type { FastifyInstance } from 'fastify';
import type { TtsRequest, DebugCaptureInfo } from '@star-cliproxy/shared';
import { createRequestId } from '../../utils/stream-transformer.js';
import { logRequest } from '../../middleware/request-logger.js';
import type { ModelRouter } from '../../services/router.js';
import type { QueueManager } from '../../services/queue.js';
import type { RateLimiter } from '../../middleware/rate-limiter.js';
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import type { HealthChecker } from '../../services/health-checker.js';
import type { ActiveRequestTracker } from '../../services/active-requests.js';
import type { DebugService } from '../../services/debug.js';

interface AudioSpeechDeps {
  router: ModelRouter;
  queue: QueueManager;
  rateLimiter: RateLimiter;
  registry: ProviderRegistry;
  healthChecker: HealthChecker;
  activeRequests: ActiveRequestTracker;
  debug: DebugService;
}

// response_format → Content-Type 매핑
const FORMAT_CONTENT_TYPE: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};

function sanitizeProviderError(message: string): string {
  return message
    .replace(/\/[\w/.@-]+/g, '[path]')
    .replace(/at\s+\S+\s*\(.*?\)/g, '')
    .trim()
    .substring(0, 200);
}

export function registerAudioSpeechRoute(
  app: FastifyInstance,
  deps: AudioSpeechDeps,
): void {
  app.post<{ Body: TtsRequest }>(
    '/v1/audio/speech',
    async (request, reply) => {
      const startTime = Date.now();
      const requestId = createRequestId();
      const body = request.body;

      // 입력 검증
      if (!body.model || !body.input || !body.voice) {
        return reply.status(400).send({
          error: {
            message: 'model, input, and voice are required.',
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_request',
          },
        });
      }

      if (body.speed !== undefined && (body.speed < 0.25 || body.speed > 4.0)) {
        return reply.status(400).send({
          error: {
            message: 'speed must be between 0.25 and 4.0.',
            type: 'invalid_request_error',
            param: 'speed',
            code: 'invalid_request',
          },
        });
      }

      const responseFormat = body.response_format ?? 'mp3';
      if (!FORMAT_CONTENT_TYPE[responseFormat]) {
        return reply.status(400).send({
          error: {
            message: `Unsupported response_format: "${responseFormat}". Supported: mp3, opus, aac, flac, wav, pcm.`,
            type: 'invalid_request_error',
            param: 'response_format',
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

        // TTS 지원 여부 확인
        if (!provider.endpointTypes.includes('tts')) {
          lastError = new Error(`Provider ${route.provider} does not support text-to-speech`);
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
            requestMessages: [{ role: 'user', content: `[TTS] voice=${body.voice} format=${responseFormat}: ${body.input.slice(0, 100)}` }],
          });
        }

        try {
          const result = await deps.queue.enqueue(
            route.provider,
            () => provider.executeTts({
              model: route.actualModel,
              input: body.input,
              voice: body.voice,
              responseFormat,
              speed: body.speed,
              signal: request.raw.destroyed ? AbortSignal.abort() : undefined,
              onDebug,
            }),
          );

          const latencyMs = Date.now() - startTime;

          reply.header('X-Request-ID', requestId);
          reply.header('Content-Type', result.contentType);

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
            totalTokens: 0,
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
              parsedContent: `[Audio ${responseFormat}, ${result.audio.length} bytes]`,
              status: 'success',
              latencyMs,
            });
          }

          deps.activeRequests.finish(requestId);
          return reply.status(200).send(result.audio);
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
