import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n/context';
import {
  fetchProviders,
  fetchProviderConfig,
  updateProviderConfig,
  testProvider,
  type ProviderInfo,
  type ProviderConfig,
  type ProviderTestResult,
} from '../api/client';

interface ProviderState {
  info: ProviderInfo;
  config: ProviderConfig | null;
  loading: boolean;
}

export default function ProvidersPage() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<ProviderState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<ProviderConfig>>({});
  const [extraArgsText, setExtraArgsText] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);

  // 프로바이더 목록 + 설정 로드
  const loadAll = async () => {
    try {
      const infos = await fetchProviders();
      const states: ProviderState[] = infos.map((info) => ({
        info,
        config: null,
        loading: true,
      }));
      setProviders(states);
      setError(null);

      // 각 프로바이더 설정 병렬 로드
      const configs = await Promise.allSettled(
        infos.map((info) => fetchProviderConfig(info.name)),
      );

      setProviders(
        infos.map((info, i) => ({
          info,
          config: configs[i].status === 'fulfilled' ? configs[i].value : null,
          loading: false,
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => { loadAll(); }, []);

  // 카드 확장/축소
  const toggleExpand = (name: string) => {
    if (expandedProvider === name) {
      setExpandedProvider(null);
      setDraft({});
      setExtraArgsText('');
      setTestResult(null);
      setMessage(null);
      return;
    }

    const prov = providers.find((p) => p.info.name === name);
    if (prov?.config) {
      setDraft({ ...prov.config });
      setExtraArgsText((prov.config.extra_args ?? []).join('\n'));
    }
    setExpandedProvider(name);
    setTestResult(null);
    setMessage(null);
  };

  // 설정 저장
  const handleSave = async (name: string) => {
    setSaving(true);
    setMessage(null);
    try {
      const payload: Partial<ProviderConfig> = {
        ...draft,
        extra_args: extraArgsText.split('\n').filter(Boolean),
      };
      // enabled는 boolean으로 전달
      const result = await updateProviderConfig(name, payload);

      // 로컬 상태 갱신
      setProviders((prev) =>
        prev.map((p) =>
          p.info.name === name ? { ...p, config: result } : p,
        ),
      );
      setDraft({ ...result });
      setExtraArgsText((result.extra_args ?? []).join('\n'));
      setMessage({ type: 'success', text: t('providers.saved') });
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  // 프로바이더 테스트
  const handleTest = async (name: string) => {
    setTesting(name);
    setTestResult(null);
    try {
      const result = await testProvider(name);
      setTestResult(result);
    } catch (e) {
      setTestResult({
        success: false,
        error: e instanceof Error ? e.message : String(e),
        latencyMs: 0,
      });
    } finally {
      setTesting(null);
    }
  };

  // 드래프트 필드 업데이트 헬퍼
  const updateDraft = (field: keyof ProviderConfig, value: string | number | boolean) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
    setMessage(null);
  };

  if (error) {
    return (
      <div className="space-y-4 max-w-3xl">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('providers.title')}</h2>
        <div className="px-4 py-3 rounded-lg border bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-600 dark:text-red-400 text-sm">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('providers.title')}</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('providers.description')}</p>
        </div>
        <button
          onClick={loadAll}
          className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded-lg text-sm text-gray-700 dark:text-gray-200 transition-colors"
        >
          {t('common.refresh')}
        </button>
      </div>

      {/* 프로바이더 카드 목록 */}
      <div className="space-y-3">
        {providers.map(({ info, config, loading }) => {
          const isExpanded = expandedProvider === info.name;
          const statusColor =
            info.status === 'healthy'
              ? 'bg-green-500'
              : info.status === 'unhealthy'
                ? 'bg-red-500'
                : 'bg-gray-400';

          return (
            <div
              key={info.name}
              className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden"
            >
              {/* 카드 헤더 */}
              <div
                className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                onClick={() => toggleExpand(info.name)}
              >
                <div className="flex items-center gap-3">
                  <span className={`w-2.5 h-2.5 rounded-full ${statusColor}`} />
                  <span className="text-sm font-semibold text-gray-800 dark:text-gray-200 capitalize">
                    {info.name}
                  </span>
                  {config && (
                    <span className="text-xs text-gray-400 dark:text-gray-500">
                      {config.default_model} | {t('providers.maxConcurrent')}: {config.max_concurrent}
                    </span>
                  )}
                  {loading && (
                    <span className="text-xs text-gray-400 dark:text-gray-500">{t('common.loading')}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400 dark:text-gray-500">
                    {info.status === 'healthy'
                      ? t('common.online')
                      : info.status === 'unhealthy'
                        ? t('common.offline')
                        : t('common.unknown')}
                  </span>
                  <svg
                    className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>

              {/* 확장된 설정 편집 폼 */}
              {isExpanded && config && (
                <div className="border-t border-gray-200 dark:border-gray-800 px-5 py-4 space-y-4">
                  {/* 메시지 */}
                  {message && (
                    <div
                      className={`px-4 py-3 rounded-lg border text-sm ${
                        message.type === 'success'
                          ? 'bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/30 text-green-600 dark:text-green-400'
                          : 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-600 dark:text-red-400'
                      }`}
                    >
                      {message.text}
                    </div>
                  )}

                  {/* 설정 필드 */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1.5">
                        {t('providers.cliPath')}
                      </label>
                      <input
                        type="text"
                        value={draft.cli_path ?? ''}
                        onChange={(e) => updateDraft('cli_path', e.target.value)}
                        className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1.5">
                        {t('providers.defaultModel')}
                      </label>
                      <input
                        type="text"
                        value={draft.default_model ?? ''}
                        onChange={(e) => updateDraft('default_model', e.target.value)}
                        className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1.5">
                        {t('providers.maxConcurrent')}
                      </label>
                      <input
                        type="number"
                        min="1"
                        value={draft.max_concurrent ?? 1}
                        onChange={(e) => updateDraft('max_concurrent', parseInt(e.target.value) || 1)}
                        className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1.5">
                        {t('providers.timeoutMs')}
                        {draft.timeout_ms ? (
                          <span className="text-gray-400 dark:text-gray-600 ml-1">
                            ({(draft.timeout_ms / 1000).toFixed(0)}s)
                          </span>
                        ) : null}
                      </label>
                      <input
                        type="number"
                        min="1000"
                        step="1000"
                        value={draft.timeout_ms ?? 120000}
                        onChange={(e) => updateDraft('timeout_ms', parseInt(e.target.value) || 120000)}
                        className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1.5">
                      {t('providers.workingDir')}
                    </label>
                    <input
                      type="text"
                      value={draft.working_dir ?? ''}
                      onChange={(e) => updateDraft('working_dir', e.target.value)}
                      placeholder="/tmp"
                      className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1.5">
                      {t('providers.extraArgs')}
                      <span className="text-gray-400 dark:text-gray-600 ml-1">
                        ({t('providers.extraArgsHint')})
                      </span>
                    </label>
                    <textarea
                      rows={3}
                      value={extraArgsText}
                      onChange={(e) => {
                        setExtraArgsText(e.target.value);
                        setMessage(null);
                      }}
                      className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200 font-mono"
                      placeholder="--flag1&#10;--flag2=value"
                    />
                  </div>

                  {/* 테스트 결과 */}
                  {testResult && (
                    <div
                      className={`px-4 py-3 rounded-lg border text-sm space-y-1 ${
                        testResult.success
                          ? 'bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/30 text-green-700 dark:text-green-400'
                          : 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-400'
                      }`}
                    >
                      <div className="font-medium">
                        {testResult.success ? t('providers.testSuccess') : t('providers.testFailed')}
                      </div>
                      <div className="text-xs opacity-80">
                        {t('providers.latency')}: {testResult.latencyMs}ms
                      </div>
                      {testResult.response && (
                        <div className="text-xs opacity-80">
                          {t('providers.response')}: {testResult.response}
                        </div>
                      )}
                      {testResult.error && (
                        <div className="text-xs opacity-80">
                          {testResult.error}
                        </div>
                      )}
                      {testResult.usage && (
                        <div className="text-xs opacity-80">
                          Tokens: {testResult.usage.promptTokens} in / {testResult.usage.completionTokens} out
                        </div>
                      )}
                    </div>
                  )}

                  {/* 버튼 */}
                  <div className="flex gap-3 pt-2">
                    <button
                      onClick={() => handleSave(info.name)}
                      disabled={saving}
                      className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors"
                    >
                      {saving ? t('common.saving') : t('common.save')}
                    </button>
                    <button
                      onClick={() => handleTest(info.name)}
                      disabled={testing === info.name}
                      className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors"
                    >
                      {testing === info.name ? t('providers.testing') : t('common.test')}
                    </button>
                    <button
                      onClick={() => toggleExpand(info.name)}
                      className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded-lg text-sm text-gray-700 dark:text-gray-200 transition-colors"
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {providers.length === 0 && !error && (
        <div className="text-gray-400 dark:text-gray-500 text-sm">{t('common.loading')}</div>
      )}
    </div>
  );
}
