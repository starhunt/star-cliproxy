import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n/context';
import { fetchModelMappings, fetchServerInfo, type ModelMapping } from '../api/client';

function CodeBlock({ title, lang, children }: { title?: string; lang?: string; children: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation();
  const handleCopy = () => {
    navigator.clipboard.writeText(children.trim());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="relative group">
      {title && <div className="text-xs text-gray-400 dark:text-gray-500 mb-1">{title}{lang && <span className="ml-2 text-gray-500 dark:text-gray-600">({lang})</span>}</div>}
      <pre className="bg-gray-100 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg p-4 text-sm text-gray-700 dark:text-gray-300 overflow-x-auto">
        <code>{children.trim()}</code>
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 px-2 py-1 text-xs bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 rounded opacity-0 group-hover:opacity-100 transition-opacity text-gray-600 dark:text-gray-300"
      >
        {copied ? t('common.copied') : t('common.copy')}
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-200 border-b border-gray-200 dark:border-gray-800 pb-2">{title}</h3>
      {children}
    </section>
  );
}

export default function ApiGuidePage() {
  const { t } = useTranslation();
  const [models, setModels] = useState<ModelMapping[]>([]);
  const [apiBase, setApiBase] = useState('${apiBase}');
  const [dashboardUrl, setDashboardUrl] = useState('${dashboardUrl}');

  useEffect(() => {
    fetchModelMappings().then(setModels).catch(() => {});
    // 서버에서 실제 포트 정보를 가져와서 현재 호스트와 조합
    fetchServerInfo().then((info) => {
      const host = window.location.hostname;
      setApiBase(`http://${host}:${info.serverPort}`);
      setDashboardUrl(`http://${host}:${info.dashboardPort}`);
    }).catch(() => {
      // 실패 시 현재 브라우저 호스트 기반 추정
      const host = window.location.hostname;
      setApiBase(`http://${host}:8300`);
      setDashboardUrl(window.location.origin);
    });
  }, []);

  const enabledModels = models.filter(m => m.enabled);

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('guide.title')}</h2>
        <p className="text-gray-500 dark:text-gray-400 mt-1">{t('guide.subtitle')}</p>
      </div>

      {/* 개요 */}
      <Section title={t('guide.overview')}>
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
            <div className="text-xs text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">{t('guide.apiBaseUrl')}</div>
            <code className="text-blue-600 dark:text-blue-400">{apiBase}/v1</code>
          </div>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
            <div className="text-xs text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">{t('guide.dashboard')}</div>
            <code className="text-blue-600 dark:text-blue-400">{dashboardUrl}</code>
          </div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 space-y-2 text-sm text-gray-600 dark:text-gray-400">
          <p>{t('guide.overviewDescription')}</p>
          <ul className="list-disc list-inside space-y-1 text-gray-500">
            <li>{t('guide.overviewFeature1')}</li>
            <li>{t('guide.overviewFeature2')}</li>
            <li>{t('guide.overviewFeature3')}</li>
            <li>{t('guide.overviewFeature4')}</li>
            <li>{t('guide.overviewFeature5')}</li>
            <li>{t('guide.overviewFeature6')}</li>
          </ul>
        </div>
      </Section>

      {/* 인증 */}
      <Section title={t('guide.authentication')}>
        <p className="text-sm text-gray-600 dark:text-gray-400">{t('guide.authDescription')}</p>
        <CodeBlock title={t('guide.authHeaderFormat')}>
{`Authorization: Bearer sk-proxy-your-key-here`}
        </CodeBlock>
        <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg p-3 text-sm text-amber-700 dark:text-amber-300">
          {t('guide.authKeyNote', { link: '' }).split('{link}')[0]}
          <a href="/keys" className="underline hover:text-amber-600 dark:hover:text-amber-200">{t('guide.authKeyLink')}</a>
          {t('guide.authKeyNote', { link: '' }).split('{link}')[1] ?? ''}
        </div>
      </Section>

      {/* 사용 가능한 모델 */}
      <Section title={t('guide.availableModels')}>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('guide.availableModelsDescription', { link: '' }).split('{link}')[0]}
          <a href="/models" className="text-blue-600 dark:text-blue-400 underline hover:text-blue-500 dark:hover:text-blue-300">{t('guide.availableModelsLink')}</a>
          {t('guide.availableModelsDescription', { link: '' }).split('{link}')[1] ?? ''}
        </p>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 text-gray-400 dark:text-gray-500 text-xs uppercase">
                <th className="text-left px-4 py-2">{t('guide.modelAlias')}</th>
                <th className="text-left px-4 py-2">{t('guide.provider')}</th>
                <th className="text-left px-4 py-2">{t('guide.actualModel')}</th>
              </tr>
            </thead>
            <tbody>
              {enabledModels.map(m => (
                <tr key={m.id} className="border-b border-gray-100 dark:border-gray-800/50">
                  <td className="px-4 py-2 font-mono text-blue-600 dark:text-blue-400">{m.alias}</td>
                  <td className="px-4 py-2 capitalize text-gray-500 dark:text-gray-400">{m.provider}</td>
                  <td className="px-4 py-2 font-mono text-gray-400 dark:text-gray-500">{m.actualModel}</td>
                </tr>
              ))}
              {enabledModels.length === 0 && (
                <tr><td colSpan={3} className="px-4 py-4 text-center text-gray-400 dark:text-gray-600">{t('guide.noModels')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      {/* 엔드포인트 */}
      <Section title={t('guide.endpoints')}>
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg px-4 py-2">
            <span className="px-2 py-0.5 bg-green-100 dark:bg-green-500/20 text-green-600 dark:text-green-400 rounded text-xs font-mono">POST</span>
            <code className="text-gray-700 dark:text-gray-300">/v1/chat/completions</code>
            <span className="text-gray-400 dark:text-gray-600 ml-auto">{t('guide.endpointChat')}</span>
          </div>
          <div className="flex items-center gap-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg px-4 py-2">
            <span className="px-2 py-0.5 bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 rounded text-xs font-mono">GET</span>
            <code className="text-gray-700 dark:text-gray-300">/v1/models</code>
            <span className="text-gray-400 dark:text-gray-600 ml-auto">{t('guide.endpointModels')}</span>
          </div>
          <div className="flex items-center gap-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg px-4 py-2">
            <span className="px-2 py-0.5 bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 rounded text-xs font-mono">GET</span>
            <code className="text-gray-700 dark:text-gray-300">/health</code>
            <span className="text-gray-400 dark:text-gray-600 ml-auto">{t('guide.endpointHealth')}</span>
          </div>
        </div>
      </Section>

      {/* 사용 예제 */}
      <Section title={t('guide.usageExamples')}>

        <CodeBlock title={t('guide.curlNonStreaming')} lang="bash">
{`curl ${apiBase}/v1/chat/completions \\
  -H "Authorization: Bearer sk-proxy-your-key-here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet",
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ]
  }'`}
        </CodeBlock>

        <CodeBlock title={t('guide.curlStreaming')} lang="bash">
{`curl ${apiBase}/v1/chat/completions \\
  -H "Authorization: Bearer sk-proxy-your-key-here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet",
    "messages": [
      {"role": "user", "content": "Tell me a joke"}
    ],
    "stream": true
  }'`}
        </CodeBlock>

        <CodeBlock title={t('guide.pythonSdk')} lang="python">
{`from openai import OpenAI

client = OpenAI(
    base_url="${apiBase}/v1",
    api_key="sk-proxy-your-key-here",
)

# Non-streaming
response = client.chat.completions.create(
    model="claude-sonnet",
    messages=[{"role": "user", "content": "Summarize this document"}],
)
print(response.choices[0].message.content)

# Streaming
stream = client.chat.completions.create(
    model="antigravity",
    messages=[{"role": "user", "content": "Write a haiku"}],
    stream=True,
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
print()`}
        </CodeBlock>

        <CodeBlock title={t('guide.typescriptSdk')} lang="typescript">
{`import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${apiBase}/v1',
  apiKey: 'sk-proxy-your-key-here',
});

// Non-streaming
const response = await client.chat.completions.create({
  model: 'claude-sonnet',
  messages: [{ role: 'user', content: 'Hello' }],
});
console.log(response.choices[0].message.content);

// Streaming
const stream = await client.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Tell me a story' }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}`}
        </CodeBlock>

        <CodeBlock title={t('guide.modelList')} lang="bash">
{`curl ${apiBase}/v1/models \\
  -H "Authorization: Bearer sk-proxy-your-key-here"`}
        </CodeBlock>
      </Section>

      {/* 비전 / 이미지 입력 */}
      <Section title={t('guide.vision')}>
        <p className="text-sm text-gray-600 dark:text-gray-400">{t('guide.visionDescription')}</p>
        <CodeBlock title={t('guide.visionAgyExample')} lang="bash">
{`curl ${apiBase}/v1/chat/completions \\
  -H "Authorization: Bearer sk-proxy-your-key-here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "antigravity",
    "messages": [
      {"role": "user", "content": "Describe this image: @/absolute/path/to/image.png"}
    ]
  }'`}
        </CodeBlock>
        <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg p-3 text-sm text-amber-700 dark:text-amber-300">
          {t('guide.visionNote')}
        </div>
      </Section>

      {/* 응답 형식 */}
      <Section title={t('guide.responseFormat')}>
        <CodeBlock title={t('guide.nonStreamingResponse')}>
{`{
  "id": "chatcmpl-proxy-abc123",
  "object": "chat.completion",
  "created": 1710000000,
  "model": "claude-sonnet",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help you?"
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 8,
    "total_tokens": 18
  }
}`}
        </CodeBlock>

        <CodeBlock title={t('guide.streamingResponse')}>
{`data: {"id":"chatcmpl-proxy-abc123","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-proxy-abc123","object":"chat.completion.chunk","choices":[{"delta":{"content":"!"},"finish_reason":null}]}

data: {"id":"chatcmpl-proxy-abc123","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}]}

data: [DONE]`}
        </CodeBlock>
      </Section>

      {/* 에러 처리 */}
      <Section title={t('guide.errorHandling')}>
        <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
          <p>{t('guide.errorDescription')}</p>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-3">
            <span className="text-red-500 dark:text-red-400 font-mono">401</span>
            <span className="text-gray-500 ml-2">{t('guide.error401')}</span>
          </div>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-3">
            <span className="text-amber-500 dark:text-amber-400 font-mono">429</span>
            <span className="text-gray-500 ml-2">{t('guide.error429')}</span>
          </div>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-3">
            <span className="text-red-500 dark:text-red-400 font-mono">400</span>
            <span className="text-gray-500 ml-2">{t('guide.error400')}</span>
          </div>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-3">
            <span className="text-red-500 dark:text-red-400 font-mono">502</span>
            <span className="text-gray-500 ml-2">{t('guide.error502')}</span>
          </div>
        </div>
        <CodeBlock title={t('guide.errorExample')}>
{`{
  "error": {
    "message": "Rate limit exceeded. Retry after 30 seconds.",
    "type": "rate_limit_error",
    "param": null,
    "code": "rate_limit_exceeded"
  }
}`}
        </CodeBlock>
      </Section>

      {/* 레이트 리밋 */}
      <Section title={t('guide.rateLimits')}>
        <p className="text-sm text-gray-600 dark:text-gray-400">{t('guide.rateLimitsDescription')}</p>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-3">
            <div className="text-xs text-gray-400 dark:text-gray-500 uppercase mb-1">{t('guide.rateLimitsGlobal')}</div>
            <div className="text-gray-700 dark:text-gray-300">60 RPM / 1,000 RPD</div>
          </div>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-3">
            <div className="text-xs text-gray-400 dark:text-gray-500 uppercase mb-1">{t('guide.rateLimitsPerProvider')}</div>
            <div className="text-gray-700 dark:text-gray-300">20 RPM each</div>
          </div>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-3">
            <div className="text-xs text-gray-400 dark:text-gray-500 uppercase mb-1">{t('guide.rateLimitsPerKey')}</div>
            <div className="text-gray-700 dark:text-gray-300">{t('guide.rateLimitsPerKeyValue')}</div>
          </div>
        </div>
      </Section>

      {/* 팁 */}
      <Section title={t('guide.tips')}>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 space-y-2 text-sm text-gray-600 dark:text-gray-400">
          <ul className="list-disc list-inside space-y-2">
            <li>
              <strong className="text-gray-700 dark:text-gray-300">{t('guide.tipSystemPrompt')}</strong> {t('guide.tipSystemPromptDesc')}
            </li>
            <li>
              <strong className="text-gray-700 dark:text-gray-300">{t('guide.tipFallback')}</strong> {t('guide.tipFallbackDesc')}
            </li>
            <li>
              <strong className="text-gray-700 dark:text-gray-300">{t('guide.tipHeaders')}</strong> {t('guide.tipHeadersDesc')}
            </li>
            <li>
              <strong className="text-gray-700 dark:text-gray-300">{t('guide.tipHealth')}</strong> {t('guide.tipHealthDesc')}
            </li>
            <li>
              <strong className="text-gray-700 dark:text-gray-300">{t('guide.tipContentParts')}</strong> {t('guide.tipContentPartsDesc')}
            </li>
          </ul>
        </div>
      </Section>
    </div>
  );
}
