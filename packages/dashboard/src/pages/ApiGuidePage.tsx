import { useEffect, useState } from 'react';
import { fetchModelMappings, type ModelMapping } from '../api/client';

function CodeBlock({ title, lang, children }: { title?: string; lang?: string; children: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(children.trim());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="relative group">
      {title && <div className="text-xs text-gray-500 mb-1">{title}{lang && <span className="ml-2 text-gray-600">({lang})</span>}</div>}
      <pre className="bg-gray-950 border border-gray-800 rounded-lg p-4 text-sm text-gray-300 overflow-x-auto">
        <code>{children.trim()}</code>
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 rounded opacity-0 group-hover:opacity-100 transition-opacity"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-lg font-semibold text-gray-200 border-b border-gray-800 pb-2">{title}</h3>
      {children}
    </section>
  );
}

export default function ApiGuidePage() {
  const [models, setModels] = useState<ModelMapping[]>([]);
  useEffect(() => {
    fetchModelMappings().then(setModels).catch(() => {});
  }, []);

  const enabledModels = models.filter(m => m.enabled);

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h2 className="text-2xl font-bold">API Guide</h2>
        <p className="text-gray-400 mt-1">star-cliproxy는 OpenAI-compatible API를 제공합니다. 기존 OpenAI SDK의 base_url만 변경하면 즉시 사용 가능합니다.</p>
      </div>

      {/* Overview */}
      <Section title="Overview">
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">API Base URL</div>
            <code className="text-blue-400">http://localhost:8300/v1</code>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Dashboard</div>
            <code className="text-blue-400">http://localhost:5300</code>
          </div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-2 text-sm text-gray-400">
          <p>star-cliproxy는 Claude, Codex, Gemini CLI를 서브프로세스로 호출하여 구독 내에서 API 호출을 제공합니다.</p>
          <ul className="list-disc list-inside space-y-1 text-gray-500">
            <li>OpenAI SDK 호환 — base_url만 변경하면 기존 코드 그대로 사용</li>
            <li>모델 매핑 — alias를 등록하면 자동으로 적절한 CLI/모델로 라우팅</li>
            <li>자동 폴백 — 1순위 provider 실패 시 2순위로 자동 전환</li>
            <li>스트리밍 — SSE 방식의 실시간 응답 지원</li>
          </ul>
        </div>
      </Section>

      {/* Authentication */}
      <Section title="Authentication">
        <p className="text-sm text-gray-400">모든 API 요청에 <code className="text-amber-400">Authorization</code> 헤더가 필요합니다.</p>
        <CodeBlock title="Header format">
{`Authorization: Bearer sk-proxy-your-key-here`}
        </CodeBlock>
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-sm text-amber-300">
          API 키는 Dashboard의 <a href="/keys" className="underline hover:text-amber-200">API Keys</a> 페이지에서 생성/관리할 수 있습니다.
        </div>
      </Section>

      {/* Available Models */}
      <Section title="Available Models">
        <p className="text-sm text-gray-400">
          현재 등록된 모델 매핑입니다. <a href="/models" className="text-blue-400 underline hover:text-blue-300">Model Mappings</a> 페이지에서 추가/수정할 수 있습니다.
        </p>
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase">
                <th className="text-left px-4 py-2">Model (alias)</th>
                <th className="text-left px-4 py-2">Provider</th>
                <th className="text-left px-4 py-2">Actual Model</th>
              </tr>
            </thead>
            <tbody>
              {enabledModels.map(m => (
                <tr key={m.id} className="border-b border-gray-800/50">
                  <td className="px-4 py-2 font-mono text-blue-400">{m.alias}</td>
                  <td className="px-4 py-2 capitalize text-gray-400">{m.provider}</td>
                  <td className="px-4 py-2 font-mono text-gray-500">{m.actualModel}</td>
                </tr>
              ))}
              {enabledModels.length === 0 && (
                <tr><td colSpan={3} className="px-4 py-4 text-center text-gray-600">No models configured</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Endpoints */}
      <Section title="API Endpoints">
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-lg px-4 py-2">
            <span className="px-2 py-0.5 bg-green-500/20 text-green-400 rounded text-xs font-mono">POST</span>
            <code className="text-gray-300">/v1/chat/completions</code>
            <span className="text-gray-600 ml-auto">Chat completion (streaming/non-streaming)</span>
          </div>
          <div className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-lg px-4 py-2">
            <span className="px-2 py-0.5 bg-blue-500/20 text-blue-400 rounded text-xs font-mono">GET</span>
            <code className="text-gray-300">/v1/models</code>
            <span className="text-gray-600 ml-auto">List available models</span>
          </div>
          <div className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-lg px-4 py-2">
            <span className="px-2 py-0.5 bg-blue-500/20 text-blue-400 rounded text-xs font-mono">GET</span>
            <code className="text-gray-300">/health</code>
            <span className="text-gray-600 ml-auto">Health check (no auth required)</span>
          </div>
        </div>
      </Section>

      {/* Usage Examples */}
      <Section title="Usage Examples">

        <CodeBlock title="curl — Non-streaming" lang="bash">
{`curl http://localhost:8300/v1/chat/completions \\
  -H "Authorization: Bearer sk-proxy-your-key-here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet",
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ]
  }'`}
        </CodeBlock>

        <CodeBlock title="curl — Streaming" lang="bash">
{`curl http://localhost:8300/v1/chat/completions \\
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

        <CodeBlock title="Python — OpenAI SDK" lang="python">
{`from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8300/v1",
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
    model="gemini-pro",
    messages=[{"role": "user", "content": "Write a haiku"}],
    stream=True,
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
print()`}
        </CodeBlock>

        <CodeBlock title="TypeScript — OpenAI SDK" lang="typescript">
{`import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:8300/v1',
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

        <CodeBlock title="Model list" lang="bash">
{`curl http://localhost:8300/v1/models \\
  -H "Authorization: Bearer sk-proxy-your-key-here"`}
        </CodeBlock>
      </Section>

      {/* Response Format */}
      <Section title="Response Format">
        <CodeBlock title="Non-streaming response">
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

        <CodeBlock title="Streaming response (SSE)">
{`data: {"id":"chatcmpl-proxy-abc123","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-proxy-abc123","object":"chat.completion.chunk","choices":[{"delta":{"content":"!"},"finish_reason":null}]}

data: {"id":"chatcmpl-proxy-abc123","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}]}

data: [DONE]`}
        </CodeBlock>
      </Section>

      {/* Error Handling */}
      <Section title="Error Handling">
        <div className="space-y-2 text-sm text-gray-400">
          <p>에러 응답은 OpenAI 형식을 따릅니다:</p>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <span className="text-red-400 font-mono">401</span>
            <span className="text-gray-500 ml-2">Invalid or missing API key</span>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <span className="text-amber-400 font-mono">429</span>
            <span className="text-gray-500 ml-2">Rate limit exceeded (check Retry-After header)</span>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <span className="text-red-400 font-mono">400</span>
            <span className="text-gray-500 ml-2">Invalid request or unknown model</span>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <span className="text-red-400 font-mono">502</span>
            <span className="text-gray-500 ml-2">All providers failed (check provider health)</span>
          </div>
        </div>
        <CodeBlock title="Error response example">
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

      {/* Rate Limits */}
      <Section title="Rate Limits">
        <p className="text-sm text-gray-400">3계층 레이트 리미팅이 적용됩니다. 설정은 <code className="text-gray-300">config.yaml</code>에서 변경 가능합니다.</p>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <div className="text-xs text-gray-500 uppercase mb-1">Global</div>
            <div className="text-gray-300">60 RPM / 1,000 RPD</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <div className="text-xs text-gray-500 uppercase mb-1">Per Provider</div>
            <div className="text-gray-300">20 RPM each</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <div className="text-xs text-gray-500 uppercase mb-1">Per API Key</div>
            <div className="text-gray-300">Customizable per key</div>
          </div>
        </div>
      </Section>

      {/* Tips */}
      <Section title="Tips">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-2 text-sm text-gray-400">
          <ul className="list-disc list-inside space-y-2">
            <li>
              <strong className="text-gray-300">System prompt:</strong> Claude는 <code className="text-gray-400">--system-prompt</code> 플래그로 분리 전달, Codex/Gemini는 프롬프트에 포함
            </li>
            <li>
              <strong className="text-gray-300">Fallback:</strong> 같은 alias에 여러 provider를 매핑하면 priority 순으로 폴백 (Model Mappings에서 설정)
            </li>
            <li>
              <strong className="text-gray-300">Response headers:</strong> <code className="text-gray-400">X-Request-ID</code>로 요청 추적, 폴백 시 <code className="text-gray-400">X-Fallback-Provider</code> 헤더 포함
            </li>
            <li>
              <strong className="text-gray-300">Health check:</strong> <code className="text-gray-400">GET /health</code>는 인증 없이 접근 가능
            </li>
          </ul>
        </div>
      </Section>
    </div>
  );
}
