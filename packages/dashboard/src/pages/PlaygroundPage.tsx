import { useEffect, useState, useRef, useCallback } from 'react';
import { useTranslation } from '../i18n/context';
import { fetchModelMappings, fetchServerInfo, type ModelMapping, type ReasoningEffort } from '../api/client';

type ReasoningEffortValue = ReasoningEffort | '';
const REASONING_EFFORT_OPTIONS: ReasoningEffortValue[] = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

// reasoning_effort를 CLI 옵션으로 지원하는 provider만 입력 활성화
const REASONING_SUPPORTED_PROVIDERS = new Set(['claude', 'codex', 'copilot']);

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface Metrics {
  latencyMs: number;
  ttfbMs: number | null;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  const tenths = Math.floor((ms % 1000) / 100);
  if (min > 0) return `${min}:${String(s).padStart(2, '0')}.${tenths}`;
  return `${s}.${tenths}s`;
}

const STORAGE_KEY = 'playground_state';

interface PlaygroundState {
  model: string;
  apiKey: string;
  messages: Message[];
  response: string;
  metrics: Metrics | null;
}

function loadPlaygroundState(): PlaygroundState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { model: '', apiKey: '', messages: [{ role: 'user', content: '' }], response: '', metrics: null };
}

function savePlaygroundState(state: Partial<PlaygroundState>) {
  try {
    const current = loadPlaygroundState();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...state }));
  } catch { /* ignore */ }
}

export default function PlaygroundPage() {
  const { t } = useTranslation();

  // 모델 목록
  const [models, setModels] = useState<ModelMapping[]>([]);
  const [apiBaseUrl, setApiBaseUrl] = useState('');

  // 입력 상태
  // localStorage에서 이전 상태 복원
  const saved = useRef(loadPlaygroundState());
  const [selectedModel, setSelectedModel] = useState(saved.current.model);
  const [apiKey, setApiKey] = useState(saved.current.apiKey);
  const [messages, setMessages] = useState<Message[]>(saved.current.messages);
  const [stream, setStream] = useState(false);
  const [temperature, setTemperature] = useState<string>('');
  const [maxTokens, setMaxTokens] = useState<string>('');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffortValue>('');

  // 선택된 모델의 provider → reasoning_effort 지원 여부
  const selectedProvider = models.find((m) => m.alias === selectedModel)?.provider ?? '';
  const supportsReasoning = REASONING_SUPPORTED_PROVIDERS.has(selectedProvider);

  // provider 변경되어 비지원 상태가 되면 값 자동 클리어 (잘못된 요청 방지)
  useEffect(() => {
    if (!supportsReasoning && reasoningEffort !== '') {
      setReasoningEffort('');
    }
  }, [supportsReasoning, reasoningEffort]);

  // 응답 상태 (이전 결과 복원)
  const [response, setResponse] = useState(saved.current.response);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(saved.current.metrics);
  const [showPreview, setShowPreview] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const elapsedRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const responseRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchModelMappings().then((m) => {
      const enabled = m.filter((x) => x.enabled);
      setModels(enabled);
      if (enabled.length > 0 && !selectedModel) {
        // 저장된 모델이 목록에 있으면 유지, 없으면 첫 번째
        const savedModel = saved.current.model;
        const exists = enabled.some((x) => x.alias === savedModel);
        setSelectedModel(exists ? savedModel : enabled[0].alias);
      }
    }).catch(() => {});
    // API base URL 결정 (Vite 프록시 경유 시 상대 경로 사용)
    fetchServerInfo().then((info) => {
      setApiBaseUrl(`http://${window.location.hostname}:${info.serverPort}`);
    }).catch(() => {
      setApiBaseUrl('');
    });
  }, []);

  // 상태 변경 시 localStorage 저장
  useEffect(() => { savePlaygroundState({ apiKey }); }, [apiKey]);
  useEffect(() => { savePlaygroundState({ model: selectedModel }); }, [selectedModel]);
  useEffect(() => { savePlaygroundState({ messages }); }, [messages]);
  useEffect(() => { savePlaygroundState({ response }); }, [response]);
  useEffect(() => { if (metrics) savePlaygroundState({ metrics }); }, [metrics]);

  // 메시지 관리
  const updateMessage = (idx: number, field: 'role' | 'content', value: string) => {
    setMessages((prev) => prev.map((m, i) => i === idx ? { ...m, [field]: value } : m));
  };
  const addMessage = () => setMessages((prev) => [...prev, { role: 'user', content: '' }]);
  const removeMessage = (idx: number) => setMessages((prev) => prev.filter((_, i) => i !== idx));

  // 요청 body 생성
  const buildRequestBody = useCallback(() => {
    const body: Record<string, unknown> = {
      model: selectedModel,
      messages: messages.filter((m) => m.content.trim()),
      stream,
    };
    if (temperature) body.temperature = parseFloat(temperature);
    if (maxTokens) body.max_tokens = parseInt(maxTokens);
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    return body;
  }, [selectedModel, messages, stream, temperature, maxTokens, reasoningEffort]);

  // 전송
  const handleSend = async () => {
    if (!selectedModel || !apiKey) return;
    const filteredMessages = messages.filter((m) => m.content.trim());
    if (filteredMessages.length === 0) return;

    setLoading(true);
    setError(null);
    setResponse('');
    setMetrics(null);
    setElapsed(0);

    // 경과 시간 타이머 (100ms 간격)
    const timerStart = Date.now();
    elapsedRef.current = setInterval(() => {
      setElapsed(Date.now() - timerStart);
    }, 100);

    const controller = new AbortController();
    abortRef.current = controller;

    const startTime = Date.now();
    let ttfbMs: number | null = null;

    try {
      // Vite 프록시 경유 (상대 경로)
      const url = '/v1/chat/completions';
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(buildRequestBody()),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: { message: res.statusText } }));
        throw new Error(errBody.error?.message ?? `HTTP ${res.status}`);
      }

      if (stream && res.body) {
        // SSE 스트리밍 처리
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';
        let usage = null;
        let streamDone = false;

        while (!streamDone) {
          const { done, value } = await reader.read();
          if (done) break;

          if (ttfbMs === null) ttfbMs = Date.now() - startTime;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') {
              streamDone = true;
              break;
            }

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.delta?.reasoning;
              if (delta) {
                accumulated += delta;
                setResponse(accumulated);
              }
              if (parsed.usage) usage = parsed.usage;
              // finish_reason이 있으면 스트림 종료
              if (parsed.choices?.[0]?.finish_reason) {
                streamDone = true;
                break;
              }
            } catch { /* 파싱 실패 무시 */ }
          }
        }

        // 스트림 정리
        reader.cancel().catch(() => {});

        setMetrics({
          latencyMs: Date.now() - startTime,
          ttfbMs,
          usage,
        });
      } else {
        // Non-streaming
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content ?? '';
        setResponse(content);
        setMetrics({
          latencyMs: Date.now() - startTime,
          ttfbMs: null,
          usage: data.usage ?? null,
        });
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      clearInterval(elapsedRef.current);
      setLoading(false);
      abortRef.current = null;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleClear = () => {
    setResponse('');
    setError(null);
    setMetrics(null);
    setMessages([{ role: 'user', content: '' }]);
    savePlaygroundState({ response: '', metrics: null, messages: [{ role: 'user', content: '' }] });
  };

  // 자동 스크롤
  useEffect(() => {
    if (responseRef.current) {
      responseRef.current.scrollTop = responseRef.current.scrollHeight;
    }
  }, [response]);

  const inputCls = 'bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200';
  const labelCls = 'text-xs text-gray-500 dark:text-gray-400 block mb-1';

  return (
    <div className="space-y-4 max-w-4xl">
      {/* 헤더 */}
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('playground.title')}</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('playground.subtitle')}</p>
      </div>

      {/* 모델 + API 키 */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>{t('playground.model')}</label>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className={`w-full ${inputCls}`}
          >
            {models.map((m) => (
              <option key={m.id} value={m.alias}>
                {m.alias} ({m.provider}:{m.actualModel})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>{t('playground.apiKey')}</label>
          <input
            type="text"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-proxy-..."
            className={`w-full ${inputCls} font-mono`}
          />
        </div>
      </div>

      {/* 파라미터 */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 dark:text-gray-400">Temperature</label>
          <input
            type="number"
            min="0"
            max="2"
            step="0.1"
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
            placeholder="default"
            className={`w-20 ${inputCls} text-xs`}
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 dark:text-gray-400">Max Tokens</label>
          <input
            type="number"
            min="1"
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
            placeholder="default"
            className={`w-24 ${inputCls} text-xs`}
          />
        </div>
        <div className="flex items-center gap-2">
          <label className={`text-xs ${supportsReasoning ? 'text-gray-500 dark:text-gray-400' : 'text-gray-300 dark:text-gray-600'}`}>
            {t('playground.reasoningEffort')}
          </label>
          <select
            value={reasoningEffort}
            onChange={(e) => setReasoningEffort(e.target.value as ReasoningEffortValue)}
            disabled={!supportsReasoning}
            className={`w-28 ${inputCls} text-xs disabled:opacity-50 disabled:cursor-not-allowed`}
            title={supportsReasoning
              ? t('playground.reasoningEffortHint')
              : t('playground.reasoningEffortUnsupported', { provider: selectedProvider || 'this provider' })}
          >
            {REASONING_EFFORT_OPTIONS.map((value) => (
              <option key={value || 'default'} value={value}>
                {value === '' ? t('playground.reasoningEffortDefault') : value}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={stream}
            onChange={(e) => setStream(e.target.checked)}
            className="accent-blue-500"
          />
          Stream
        </label>
      </div>

      {/* 메시지 에디터 */}
      <div className="space-y-2">
        <label className={labelCls}>{t('playground.messages')}</label>
        {messages.map((msg, idx) => (
          <div key={idx} className="flex gap-2">
            <select
              value={msg.role}
              onChange={(e) => updateMessage(idx, 'role', e.target.value)}
              className={`w-28 shrink-0 ${inputCls}`}
            >
              <option value="system">system</option>
              <option value="user">user</option>
              <option value="assistant">assistant</option>
            </select>
            <textarea
              value={msg.content}
              onChange={(e) => updateMessage(idx, 'content', e.target.value)}
              rows={msg.role === 'system' ? 2 : 3}
              placeholder={msg.role === 'system' ? t('playground.systemPlaceholder') : t('playground.userPlaceholder')}
              className={`flex-1 ${inputCls} resize-y`}
            />
            {messages.length > 1 && (
              <button
                onClick={() => removeMessage(idx)}
                className="text-gray-300 dark:text-gray-700 hover:text-red-500 dark:hover:text-red-400 self-start mt-2"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        ))}
        <button
          onClick={addMessage}
          className="text-xs text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300"
        >
          + {t('playground.addMessage')}
        </button>
      </div>

      {/* 요청 미리보기 */}
      <div>
        <button
          onClick={() => setShowPreview(!showPreview)}
          className="text-xs text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400 flex items-center gap-1"
        >
          <svg className={`w-3 h-3 transition-transform ${showPreview ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          {t('playground.requestPreview')}
        </button>
        {showPreview && (
          <pre className="mt-1 bg-gray-100 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg p-3 text-xs text-gray-600 dark:text-gray-400 overflow-x-auto max-h-40 overflow-y-auto">
            {JSON.stringify(buildRequestBody(), null, 2)}
          </pre>
        )}
      </div>

      {/* 버튼 */}
      <div className="flex items-center gap-3">
        {loading ? (
          <>
            <button
              onClick={handleStop}
              className="px-6 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-sm font-medium text-white transition-colors"
            >
              {t('playground.stop')}
            </button>
            <span className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
              <span className="font-mono tabular-nums">{formatElapsed(elapsed)}</span>
              <span className="text-xs text-gray-400 dark:text-gray-500">
                {stream ? t('playground.streaming') : t('playground.processing')}
              </span>
            </span>
          </>
        ) : (
          <button
            onClick={handleSend}
            disabled={!selectedModel || !apiKey || messages.every((m) => !m.content.trim())}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors"
          >
            {t('playground.send')}
          </button>
        )}
        <button
          onClick={handleClear}
          className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded-lg text-sm text-gray-700 dark:text-gray-200 transition-colors"
        >
          {t('playground.clear')}
        </button>
      </div>

      {/* 에러 */}
      {error && (
        <div className="px-4 py-3 rounded-lg border bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-600 dark:text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* 응답 */}
      {(response || loading) && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
            <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">{t('playground.response')}</span>
            {loading && (
              <span className="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
                <span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                <span className="font-mono tabular-nums">{formatElapsed(elapsed)}</span>
              </span>
            )}
          </div>
          <div
            ref={responseRef}
            className="p-4 text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap max-h-96 overflow-y-auto min-h-[100px]"
          >
            {response || (loading ? <span className="text-gray-400 dark:text-gray-600 animate-pulse">{t('playground.waiting')}</span> : '')}
          </div>
          {metrics && (
            <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-800 flex items-center gap-4 text-xs text-gray-400 dark:text-gray-500">
              <span>{t('playground.latency')}: {metrics.latencyMs}ms</span>
              {metrics.ttfbMs !== null && <span>TTFB: {metrics.ttfbMs}ms</span>}
              {metrics.usage && (
                <span>Tokens: {metrics.usage.prompt_tokens} + {metrics.usage.completion_tokens} = {metrics.usage.total_tokens}</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
