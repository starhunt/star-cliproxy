import type { FastifyInstance } from 'fastify';
// ProviderName은 string 타입
import type { ProviderRegistry } from '../../providers/provider-registry.js';
import { inferEndpointTypeFromName } from '@star-cliproxy/shared';
import { HttpProvider } from '../../providers/http-provider.js';

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

    // HTTP 프로바이더는 config.endpoint_type에 맞는 실제 호출로 테스트.
    // 레거시(endpoint_type 미저장)는 모델명 이름 휴리스틱으로 폴백(저장 없이 동작).
    const httpEndpointType = provider instanceof HttpProvider
      ? (provider.getHttpConfig().endpoint_type
          ?? inferEndpointTypeFromName(actual_model, provider.getHttpConfig().default_model)
          ?? 'chat')
      : null;

    // chat이 아닌 플러그인 프로바이더(images, tts 등)는 프롬프트 분기
    const endpointTypes = (provider as unknown as { endpointTypes?: string[] }).endpointTypes;
    const isNonChat = endpointTypes && !endpointTypes.includes('chat');
    const testPrompt = isNonChat && endpointTypes.includes('images')
      ? 'A simple test image: blue circle on white background'
      : 'Say "OK" and nothing else.';

    try {
      let response: string;
      let usage: unknown;

      if (provider instanceof HttpProvider && httpEndpointType === 'embeddings') {
        const r = await provider.executeEmbedding({ model: actual_model, input: 'ping' });
        response = `✓ embedding: ${r.embeddings[0]?.length ?? 0}d × ${r.embeddings.length}`;
        usage = r.usage;
      } else if (provider instanceof HttpProvider && httpEndpointType === 'rerank') {
        const r = await provider.executeRerank({ model: actual_model, query: 'ping', documents: ['alpha document', 'beta document'] });
        const top = r.results[0];
        response = `✓ rerank: ${r.results.length} results` + (top ? `, top #${top.index} (${top.relevanceScore.toFixed(3)})` : '');
        usage = r.usage;
      } else if (provider instanceof HttpProvider && httpEndpointType === 'tts') {
        const r = await provider.executeTts({ model: actual_model, input: 'ping', voice: 'alloy' });
        response = `✓ tts: ${r.audio.length} bytes (${r.contentType})`;
      } else {
        const result = await provider.execute({
          messages: [{ role: 'user', content: testPrompt }],
          model: actual_model,
          stream: false,
          // 백엔드의 max_total_tokens 제한과 무관하게 통과하도록 작은 값 사용
          maxTokens: 64,
        });
        response = result.content.substring(0, 200);
        usage = result.usage;
      }

      const latencyMs = Date.now() - startTime;

      return reply.send({
        success: true,
        provider: providerName,
        model: actual_model,
        response,
        latencyMs,
        usage,
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
