import type { FastifyInstance } from 'fastify';
// ProviderName은 string 타입
import type { ProviderRegistry } from '../../providers/provider-registry.js';

interface TestModelBody {
  provider: string;
  actual_model: string;
}

export function registerTestModelRoute(
  app: FastifyInstance,
  registry: ProviderRegistry,
): void {
  app.post<{ Body: TestModelBody }>('/admin/test-model', async (request, reply) => {
    const { provider: providerName, actual_model } = request.body;

    if (!providerName || !actual_model) {
      return reply.status(400).send({
        success: false,
        error: 'provider and actual_model are required.',
      });
    }

    const provider = registry.get(providerName);
    if (!provider) {
      return reply.status(400).send({
        success: false,
        error: `Provider "${providerName}" is not enabled or not found.`,
      });
    }

    const startTime = Date.now();

    // chat이 아닌 프로바이더(images, tts 등)는 health check로 대체
    const endpointTypes = (provider as unknown as { endpointTypes?: string[] }).endpointTypes;
    const isNonChat = endpointTypes && !endpointTypes.includes('chat');

    // 이미지 프로바이더용 테스트 프롬프트
    const testPrompt = isNonChat && endpointTypes.includes('images')
      ? 'A simple test image: blue circle on white background'
      : 'Say "OK" and nothing else.';

    try {
      const result = await provider.execute({
        messages: [{ role: 'user', content: testPrompt }],
        model: actual_model,
        stream: false,
      });

      const latencyMs = Date.now() - startTime;

      return reply.send({
        success: true,
        provider: providerName,
        model: actual_model,
        response: result.content.substring(0, 200),
        latencyMs,
        usage: result.usage,
      });
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);

      return reply.status(200).send({
        success: false,
        provider: providerName,
        model: actual_model,
        error: message,
        latencyMs,
      });
    }
  });
}
