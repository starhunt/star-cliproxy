import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n/context';
import {
  fetchProviders,
  fetchProviderConfig,
  updateProviderConfig,
  testProvider,
  fetchGenericProviders,
  createGenericProvider,
  updateGenericProvider,
  deleteGenericProvider,
  testGenericProvider,
  fetchHttpProviders,
  createHttpProvider,
  updateHttpProvider,
  deleteHttpProvider,
  testHttpProvider,
  type ProviderInfo,
  type ProviderConfig,
  type ProviderTestResult,
  type GenericCliProviderConfig,
  type HttpProviderConfig,
  type HttpProviderInfo,
  type ClaudeSdkOptions,
  type CodexAppServerOptions,
} from '../api/client';

// 빌트인 프로바이더 목록
const BUILTIN_PROVIDERS = new Set(['claude', 'codex', 'copilot', 'gemini']);

interface ProviderState {
  info: ProviderInfo;
  config: ProviderConfig | null;
  loading: boolean;
}

// 커스텀 프로바이더 폼 기본값 (Ollama 예시)
const DEFAULT_GENERIC_CONFIG: Omit<GenericCliProviderConfig, 'enabled'> & { enabled: boolean } = {
  enabled: true,
  cli_path: 'ollama',
  default_model: 'llama3',
  max_concurrent: 10,
  timeout_ms: 300000,
  extra_args: [],
  prompt_mode: 'stdin',
  args_template: ['run', '{model}', '--nowordwrap'],
  output_mode: 'plain_text',
  streaming_enabled: false,
  display_name: '',
};

// Generic 프로바이더 이름인지 (DB에서 로드된 커스텀)
const genericProviderNames = new Set<string>();

// HTTP 프로바이더 이름
const httpProviderNames = new Set<string>();

// HTTP 프로바이더 폼 기본값
const DEFAULT_HTTP_CONFIG: Partial<HttpProviderConfig> = {
  enabled: true,
  base_url: 'http://localhost:8080/v1',
  default_model: '',
  max_concurrent: 5,
  timeout_ms: 300000,
  display_name: '',
};

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
  const [showAddForm, setShowAddForm] = useState(false);
  const [addDraft, setAddDraft] = useState({ name: '', ...DEFAULT_GENERIC_CONFIG });
  const [addArgsText, setAddArgsText] = useState('run\n{model}\n--nowordwrap');
  const [addExtraArgsText, setAddExtraArgsText] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [addSaving, setAddSaving] = useState(false);

  // HTTP 프로바이더 상태
  const [httpProviders, setHttpProviders] = useState<HttpProviderInfo[]>([]);
  const [showAddHttpForm, setShowAddHttpForm] = useState(false);
  const [httpDraft, setHttpDraft] = useState<{ name: string } & Partial<HttpProviderConfig>>({ name: '', ...DEFAULT_HTTP_CONFIG });
  const [httpError, setHttpError] = useState<string | null>(null);
  const [httpSaving, setHttpSaving] = useState(false);

  // 프로바이더 목록 + 설정 로드
  const loadAll = async () => {
    try {
      // Generic/HTTP 프로바이더 이름 목록도 로드
      const [infos, generics, https] = await Promise.all([
        fetchProviders(),
        fetchGenericProviders().catch(() => []),
        fetchHttpProviders().catch(() => []),
      ]);

      genericProviderNames.clear();
      for (const g of generics) genericProviderNames.add(g.name);

      httpProviderNames.clear();
      for (const h of https) httpProviderNames.add(h.name);
      setHttpProviders(https);

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
      const safePayload = BUILTIN_PROVIDERS.has(name)
        ? {
            enabled: payload.enabled,
            default_model: payload.default_model,
            max_concurrent: payload.max_concurrent,
            timeout_ms: payload.timeout_ms,
            mode: payload.mode,
            sdk_options: payload.sdk_options,
            app_server_options: payload.app_server_options,
          }
        : payload;
      // enabled는 boolean으로 전달
      const result = await updateProviderConfig(name, safePayload);

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

  // 프로바이더 활성/비활성 토글
  const handleToggleEnabled = async (name: string, currentEnabled: boolean) => {
    try {
      const result = await updateProviderConfig(name, { enabled: !currentEnabled });
      setProviders((prev) =>
        prev.map((p) =>
          p.info.name === name ? { ...p, config: result } : p,
        ),
      );
      if (expandedProvider === name) {
        setDraft((prev) => ({ ...prev, enabled: result.enabled }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // 커스텀 프로바이더 추가
  const handleAddProvider = async () => {
    setAddSaving(true);
    setAddError(null);
    try {
      const config: { name: string } & GenericCliProviderConfig = {
        ...addDraft,
        args_template: addArgsText.split('\n').filter(Boolean),
        extra_args: addExtraArgsText.split('\n').filter(Boolean),
      };
      await createGenericProvider(config);
      setShowAddForm(false);
      setAddDraft({ name: '', ...DEFAULT_GENERIC_CONFIG });
      setAddArgsText('-m {model}');
      setAddExtraArgsText('');
      loadAll();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddSaving(false);
    }
  };

  // 커스텀 프로바이더 삭제
  const handleDeleteProvider = async (name: string) => {
    if (!confirm(t('providers.confirmDelete').replace('{name}', name))) return;
    try {
      await deleteGenericProvider(name);
      setExpandedProvider(null);
      loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // 커스텀 프로바이더 설정 저장 (Generic API 경유)
  const handleSaveGeneric = async (name: string) => {
    setSaving(true);
    setMessage(null);
    try {
      const payload: Partial<GenericCliProviderConfig> = {
        ...draft,
        extra_args: extraArgsText.split('\n').filter(Boolean),
      };
      await updateGenericProvider(name, payload);
      setMessage({ type: 'success', text: t('providers.saved') });
      loadAll();
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  // HTTP 프로바이더 추가
  const handleAddHttpProvider = async () => {
    setHttpSaving(true);
    setHttpError(null);
    try {
      await createHttpProvider(httpDraft as { name: string } & Partial<HttpProviderConfig>);
      setShowAddHttpForm(false);
      setHttpDraft({ name: '', ...DEFAULT_HTTP_CONFIG });
      loadAll();
    } catch (e) {
      setHttpError(e instanceof Error ? e.message : String(e));
    } finally {
      setHttpSaving(false);
    }
  };

  // HTTP 프로바이더 삭제
  const handleDeleteHttpProvider = async (name: string) => {
    if (!confirm(t('providers.confirmDelete').replace('{name}', name))) return;
    try {
      await deleteHttpProvider(name);
      setExpandedProvider(null);
      loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // HTTP 프로바이더 설정 저장
  const handleSaveHttp = async (name: string) => {
    setSaving(true);
    setMessage(null);
    try {
      const payload: Partial<HttpProviderConfig> = { ...draft };
      await updateHttpProvider(name, payload);
      setMessage({ type: 'success', text: t('providers.saved') });
      loadAll();
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
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
      {(() => {
        const builtinProviders = providers.filter((p) => BUILTIN_PROVIDERS.has(p.info.name));
        const customProviders = providers.filter((p) => !BUILTIN_PROVIDERS.has(p.info.name));

        const renderProviderCard = ({ info, config, loading }: ProviderState) => {
          const isExpanded = expandedProvider === info.name;
          const isBuiltin = BUILTIN_PROVIDERS.has(info.name);
          const isBuiltinRestricted = isBuiltin;
          const isEnabled = config?.enabled !== false;
          const statusColor =
            !isEnabled
              ? 'bg-gray-400 dark:bg-gray-600'
              : info.status === 'healthy'
                ? 'bg-green-500'
                : info.status === 'unhealthy'
                  ? 'bg-red-500'
                  : 'bg-gray-400';

          return (
            <div
              key={info.name}
              className={`bg-white dark:bg-gray-900 border rounded-xl overflow-hidden transition-colors ${
                isBuiltin
                  ? 'border-blue-200 dark:border-blue-500/30'
                  : 'border-gray-200 dark:border-gray-800'
              } ${!isEnabled ? 'opacity-60' : ''}`}
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
                  {isBuiltin && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-500/15 text-blue-600 dark:text-blue-400 font-medium">
                      Built-in
                    </span>
                  )}
                  {config && (
                    <span className="text-xs text-gray-400 dark:text-gray-500">
                      {config.default_model} | {t('providers.maxConcurrent')}: {config.max_concurrent}
                    </span>
                  )}
                  {loading && (
                    <span className="text-xs text-gray-400 dark:text-gray-500">{t('common.loading')}</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {/* 활성/비활성 토글 */}
                  {config && (
                    <div onClick={(e) => e.stopPropagation()}>
                      <ToggleSwitch
                        enabled={isEnabled}
                        onToggle={() => handleToggleEnabled(info.name, isEnabled)}
                      />
                    </div>
                  )}
                  <span className="text-xs text-gray-400 dark:text-gray-500">
                    {!isEnabled
                      ? t('providers.disabled')
                      : info.status === 'healthy'
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
                  {/* Generic 프로바이더 안내 */}
                  {genericProviderNames.has(info.name) && (
                    <div className="px-4 py-3 rounded-lg border bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-500/20 text-blue-700 dark:text-blue-300 text-xs space-y-1">
                      <p className="font-medium">{t('providers.editGuideTitle')}</p>
                      <p className="text-blue-600 dark:text-blue-400">{t('providers.editGuideDesc')}</p>
                    </div>
                  )}
                  {isBuiltinRestricted && (
                    <div className="px-4 py-3 rounded-lg border bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/20 text-amber-700 dark:text-amber-300 text-xs">
                      {t('providers.runtimeRestricted')}
                    </div>
                  )}

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
                        disabled={isBuiltinRestricted}
                        className={`w-full border rounded px-3 py-2 text-sm ${
                          isBuiltinRestricted
                            ? 'bg-gray-100 dark:bg-gray-900 border-gray-200 dark:border-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed'
                            : 'bg-gray-50 dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-800 dark:text-gray-200'
                        }`}
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
                      disabled={isBuiltinRestricted}
                      className={`w-full border rounded px-3 py-2 text-sm ${
                        isBuiltinRestricted
                          ? 'bg-gray-100 dark:bg-gray-900 border-gray-200 dark:border-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed'
                          : 'bg-gray-50 dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-800 dark:text-gray-200'
                      }`}
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
                      disabled={isBuiltinRestricted}
                      className={`w-full border rounded px-3 py-2 text-sm font-mono ${
                        isBuiltinRestricted
                          ? 'bg-gray-100 dark:bg-gray-900 border-gray-200 dark:border-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed'
                          : 'bg-gray-50 dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-800 dark:text-gray-200'
                      }`}
                      placeholder="--flag1&#10;--flag2=value"
                    />
                  </div>

                  {/* Claude 프로바이더 전용: SDK 모드 설정 */}
                  {info.name === 'claude' && (
                    <ClaudeSdkSettings draft={draft} setDraft={setDraft} setMessage={setMessage} t={t} />
                  )}

                  {/* Codex 프로바이더 전용: App Server 모드 설정 */}
                  {info.name === 'codex' && (
                    <CodexAppServerSettings draft={draft} setDraft={setDraft} setMessage={setMessage} t={t} />
                  )}

                  {/* Generic 프로바이더 전용 필드 */}
                  {genericProviderNames.has(info.name) && (
                    <GenericFieldsEditor draft={draft} updateDraft={updateDraft} t={t} />
                  )}

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
                      onClick={() => genericProviderNames.has(info.name) ? handleSaveGeneric(info.name) : handleSave(info.name)}
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
                    {genericProviderNames.has(info.name) && (
                      <button
                        onClick={() => handleDeleteProvider(info.name)}
                        className="px-4 py-2 bg-red-100 dark:bg-red-900/30 hover:bg-red-200 dark:hover:bg-red-800/40 text-red-600 dark:text-red-400 rounded-lg text-sm transition-colors ml-auto"
                      >
                        {t('providers.deleteProvider')}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        };

        return (
          <div className="space-y-6">
            {/* 빌트인 프로바이더 */}
            {builtinProviders.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    {t('providers.builtinSection')}
                  </h3>
                  <div className="flex-1 h-px bg-blue-200 dark:bg-blue-500/20" />
                </div>
                {builtinProviders.map(renderProviderCard)}
              </div>
            )}

            {/* 커스텀/플러그인 프로바이더 */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  {t('providers.customSection')}
                </h3>
                <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
                <button
                  onClick={() => setShowAddForm(!showAddForm)}
                  className="px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-xs font-medium text-white transition-colors"
                >
                  + {t('providers.addCustom')}
                </button>
              </div>

              {/* 추가 폼 */}
              {showAddForm && (
                <AddProviderForm
                  draft={addDraft}
                  setDraft={setAddDraft}
                  argsText={addArgsText}
                  setArgsText={setAddArgsText}
                  extraArgsText={addExtraArgsText}
                  setExtraArgsText={setAddExtraArgsText}
                  error={addError}
                  saving={addSaving}
                  onSave={handleAddProvider}
                  onCancel={() => { setShowAddForm(false); setAddError(null); }}
                  t={t}
                />
              )}

              {customProviders.map(renderProviderCard)}

              {customProviders.length === 0 && !showAddForm && (
                <p className="text-xs text-gray-400 dark:text-gray-600 text-center py-4">
                  {t('providers.noCustom')}
                </p>
              )}
            </div>

            {/* HTTP 프로바이더 */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold text-purple-600 dark:text-purple-400 uppercase tracking-wider">
                  {t('providers.httpSection')}
                </h3>
                <div className="flex-1 h-px bg-purple-200 dark:bg-purple-500/20" />
                <button
                  onClick={() => setShowAddHttpForm(!showAddHttpForm)}
                  className="px-3 py-1 bg-purple-600 hover:bg-purple-700 rounded text-xs font-medium text-white transition-colors"
                >
                  + {t('providers.addHttp')}
                </button>
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                {t('providers.httpDescription')}
              </p>

              {showAddHttpForm && (
                <AddHttpProviderForm
                  draft={httpDraft}
                  setDraft={setHttpDraft}
                  error={httpError}
                  saving={httpSaving}
                  onSave={handleAddHttpProvider}
                  onCancel={() => { setShowAddHttpForm(false); setHttpError(null); }}
                  t={t}
                />
              )}

              {httpProviders.map((hp) => (
                <HttpProviderCard
                  key={hp.name}
                  hp={hp}
                  expanded={expandedProvider === `http:${hp.name}`}
                  onToggle={() => {
                    if (expandedProvider === `http:${hp.name}`) {
                      setExpandedProvider(null);
                      setDraft({});
                    } else {
                      setExpandedProvider(`http:${hp.name}`);
                      setDraft(hp.config as unknown as Partial<ProviderConfig>);
                    }
                    setTestResult(null);
                    setMessage(null);
                  }}
                  draft={draft}
                  updateDraft={updateDraft}
                  saving={saving}
                  testing={testing}
                  testResult={expandedProvider === `http:${hp.name}` ? testResult : null}
                  message={expandedProvider === `http:${hp.name}` ? message : null}
                  onSave={() => handleSaveHttp(hp.name)}
                  onDelete={() => handleDeleteHttpProvider(hp.name)}
                  onTest={async () => {
                    setTesting(hp.name);
                    setTestResult(null);
                    try {
                      const result = await testHttpProvider({ name: hp.name, ...hp.config });
                      setTestResult(result);
                    } catch (e) {
                      setTestResult({ success: false, error: e instanceof Error ? e.message : String(e), latencyMs: 0 });
                    } finally {
                      setTesting(null);
                    }
                  }}
                  t={t}
                />
              ))}

              {httpProviders.length === 0 && !showAddHttpForm && (
                <p className="text-xs text-gray-400 dark:text-gray-600 text-center py-4">
                  {t('providers.noHttp')}
                </p>
              )}
            </div>
          </div>
        );
      })()}

      {providers.length === 0 && !error && (
        <div className="text-gray-400 dark:text-gray-500 text-sm">{t('common.loading')}</div>
      )}
    </div>
  );
}

// Generic 프로바이더 수정 모드 전용 필드
function GenericFieldsEditor({ draft, updateDraft, t }: {
  draft: Partial<ProviderConfig>;
  updateDraft: (field: keyof ProviderConfig, value: string | number | boolean) => void;
  t: (key: string) => string;
}) {
  const d = draft as Record<string, unknown>;
  const labelCls = 'text-xs text-gray-500 dark:text-gray-400 block mb-1.5';
  const inputCls = 'w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200';

  return (
    <div className="space-y-4 border-t border-dashed border-gray-300 dark:border-gray-700 pt-4">
      <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('providers.genericSettings')}</p>

      {/* 프롬프트 전달 */}
      <div>
        <label className={labelCls}>{t('providers.promptMode')}</label>
        <div className="flex gap-4">
          {(['stdin', 'arg'] as const).map((mode) => (
            <label key={mode} className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
              <input
                type="radio"
                checked={(d.prompt_mode as string) === mode}
                onChange={() => updateDraft('prompt_mode' as keyof ProviderConfig, mode)}
                className="accent-blue-500"
              />
              {mode === 'stdin' ? t('providers.promptModeStdin') : t('providers.promptModeArg')}
            </label>
          ))}
        </div>
      </div>

      {/* 인자 템플릿 */}
      <div>
        <label className={labelCls}>
          {t('providers.argsTemplate')}
          <span className="text-gray-400 dark:text-gray-600 ml-1">({t('providers.argsTemplateHint')})</span>
        </label>
        <textarea
          rows={3}
          value={Array.isArray(d.args_template) ? (d.args_template as string[]).join('\n') : ''}
          onChange={(e) => updateDraft('args_template' as keyof ProviderConfig, e.target.value.split('\n').filter(Boolean) as unknown as string)}
          className={`${inputCls} font-mono`}
        />
      </div>

      {/* 출력 모드 */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>{t('providers.outputMode')}</label>
          <div className="flex gap-4">
            {(['plain_text', 'json_field'] as const).map((mode) => (
              <label key={mode} className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                <input
                  type="radio"
                  checked={(d.output_mode as string) === mode}
                  onChange={() => updateDraft('output_mode' as keyof ProviderConfig, mode)}
                  className="accent-blue-500"
                />
                {mode === 'plain_text' ? t('providers.outputPlainText') : t('providers.outputJsonField')}
              </label>
            ))}
          </div>
        </div>
        {(d.output_mode as string) === 'json_field' && (
          <div>
            <label className={labelCls}>{t('providers.outputJsonContentField')}</label>
            <input
              type="text"
              value={(d.output_json_content_field as string) ?? ''}
              onChange={(e) => updateDraft('output_json_content_field' as keyof ProviderConfig, e.target.value)}
              placeholder="response"
              className={inputCls}
            />
          </div>
        )}
      </div>

      {/* 스트리밍 */}
      <div className="flex items-center gap-2">
        <label className={labelCls + ' mb-0'}>{t('providers.streamingEnabled')}</label>
        <ToggleSwitch
          enabled={!!d.streaming_enabled}
          onToggle={() => updateDraft('streaming_enabled' as keyof ProviderConfig, !d.streaming_enabled)}
        />
      </div>
    </div>
  );
}

// 커스텀 프로바이더 추가 폼
function AddProviderForm({
  draft,
  setDraft,
  argsText,
  setArgsText,
  extraArgsText,
  setExtraArgsText,
  error,
  saving,
  onSave,
  onCancel,
  t,
}: {
  draft: { name: string } & GenericCliProviderConfig;
  setDraft: React.Dispatch<React.SetStateAction<{ name: string } & GenericCliProviderConfig>>;
  argsText: string;
  setArgsText: (v: string) => void;
  extraArgsText: string;
  setExtraArgsText: (v: string) => void;
  error: string | null;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  t: (key: string) => string;
}) {
  const [testingPre, setTestingPre] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);

  const handleTestBeforeRegister = async () => {
    setTestingPre(true);
    setTestResult(null);
    try {
      const payload: { name?: string } & GenericCliProviderConfig = {
        ...draft,
        args_template: argsText.split('\n').filter(Boolean),
        extra_args: extraArgsText.split('\n').filter(Boolean),
      };
      const result = await testGenericProvider(payload);
      setTestResult(result);
    } catch (e) {
      setTestResult({ success: false, error: e instanceof Error ? e.message : String(e), latencyMs: 0 });
    } finally {
      setTestingPre(false);
    }
  };

  const inputCls = 'w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200';
  const labelCls = 'text-xs text-gray-500 dark:text-gray-400 block mb-1.5';

  return (
    <div className="bg-white dark:bg-gray-900 border border-blue-300 dark:border-blue-500/30 rounded-xl p-5 space-y-4">
      {/* 안내 */}
      <div className="px-4 py-3 rounded-lg border bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-500/20 text-blue-700 dark:text-blue-300 text-xs space-y-1">
        <p className="font-medium">{t('providers.addGuideTitle')}</p>
        <ol className="list-decimal list-inside space-y-0.5 text-blue-600 dark:text-blue-400">
          <li>{t('providers.addGuideStep1')}</li>
          <li>{t('providers.addGuideStep2')}</li>
          <li>{t('providers.addGuideStep3')}</li>
        </ol>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-lg border bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-600 dark:text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* 기본 정보 */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>
            {t('providers.providerName')}
            <span className="text-gray-400 dark:text-gray-600 ml-1">({t('providers.providerNameHint')})</span>
          </label>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))}
            placeholder="my-ollama"
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>{t('providers.displayName')}</label>
          <input
            type="text"
            value={draft.display_name}
            onChange={(e) => setDraft((d) => ({ ...d, display_name: e.target.value }))}
            placeholder="My Ollama"
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>{t('providers.cliPath')}</label>
          <input
            type="text"
            value={draft.cli_path}
            onChange={(e) => setDraft((d) => ({ ...d, cli_path: e.target.value }))}
            placeholder="ollama"
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>{t('providers.defaultModel')}</label>
          <input
            type="text"
            value={draft.default_model}
            onChange={(e) => setDraft((d) => ({ ...d, default_model: e.target.value }))}
            placeholder="llama3"
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>{t('providers.maxConcurrent')}</label>
          <input
            type="number"
            min="1"
            value={draft.max_concurrent}
            onChange={(e) => setDraft((d) => ({ ...d, max_concurrent: parseInt(e.target.value) || 1 }))}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>
            {t('providers.timeoutMs')}
            <span className="text-gray-400 dark:text-gray-600 ml-1">({(draft.timeout_ms / 1000).toFixed(0)}s)</span>
          </label>
          <input
            type="number"
            min="1000"
            step="1000"
            value={draft.timeout_ms}
            onChange={(e) => setDraft((d) => ({ ...d, timeout_ms: parseInt(e.target.value) || 120000 }))}
            className={inputCls}
          />
        </div>
      </div>

      {/* 프롬프트 전달 방식 */}
      <div>
        <label className={labelCls}>{t('providers.promptMode')}</label>
        <div className="flex gap-4">
          {(['stdin', 'arg'] as const).map((mode) => (
            <label key={mode} className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
              <input
                type="radio"
                name="prompt_mode"
                checked={draft.prompt_mode === mode}
                onChange={() => setDraft((d) => ({ ...d, prompt_mode: mode }))}
                className="accent-blue-500"
              />
              {mode === 'stdin' ? t('providers.promptModeStdin') : t('providers.promptModeArg')}
            </label>
          ))}
        </div>
      </div>

      {/* CLI 인자 템플릿 */}
      <div>
        <label className={labelCls}>
          {t('providers.argsTemplate')}
          <span className="text-gray-400 dark:text-gray-600 ml-1">({t('providers.argsTemplateHint')})</span>
        </label>
        <textarea
          rows={3}
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          placeholder={"-m {model}\n--format json"}
          className={`${inputCls} font-mono`}
        />
      </div>

      {/* 출력 모드 */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>{t('providers.outputMode')}</label>
          <div className="flex gap-4">
            {(['plain_text', 'json_field'] as const).map((mode) => (
              <label key={mode} className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                <input
                  type="radio"
                  name="output_mode"
                  checked={draft.output_mode === mode}
                  onChange={() => setDraft((d) => ({ ...d, output_mode: mode }))}
                  className="accent-blue-500"
                />
                {mode === 'plain_text' ? t('providers.outputPlainText') : t('providers.outputJsonField')}
              </label>
            ))}
          </div>
        </div>
        {draft.output_mode === 'json_field' && (
          <div>
            <label className={labelCls}>{t('providers.outputJsonContentField')}</label>
            <input
              type="text"
              value={draft.output_json_content_field ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, output_json_content_field: e.target.value }))}
              placeholder="response"
              className={inputCls}
            />
          </div>
        )}
      </div>

      {/* 스트리밍 */}
      <div className="flex items-center gap-2">
        <label className={labelCls + ' mb-0'}>{t('providers.streamingEnabled')}</label>
        <ToggleSwitch
          enabled={draft.streaming_enabled}
          onToggle={() => setDraft((d) => ({ ...d, streaming_enabled: !d.streaming_enabled }))}
        />
      </div>

      {/* Extra Args */}
      <div>
        <label className={labelCls}>
          {t('providers.extraArgs')}
          <span className="text-gray-400 dark:text-gray-600 ml-1">({t('providers.extraArgsHint')})</span>
        </label>
        <textarea
          rows={2}
          value={extraArgsText}
          onChange={(e) => setExtraArgsText(e.target.value)}
          placeholder="--flag1&#10;--flag2=value"
          className={`${inputCls} font-mono`}
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
            <div className="text-xs opacity-80">{t('providers.response')}: {testResult.response}</div>
          )}
          {testResult.error && (
            <div className="text-xs opacity-80">{testResult.error}</div>
          )}
        </div>
      )}

      {/* 버튼 */}
      <div className="flex gap-3 pt-2">
        <button
          onClick={handleTestBeforeRegister}
          disabled={testingPre || !draft.cli_path}
          className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors"
        >
          {testingPre ? t('providers.testing') : t('common.test')}
        </button>
        <button
          onClick={onSave}
          disabled={saving || !draft.name || !draft.cli_path}
          className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors"
        >
          {saving ? t('common.saving') : t('providers.addCustom')}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded-lg text-sm text-gray-700 dark:text-gray-200 transition-colors"
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

// Claude 프로바이더 전용: SDK 모드 설정 섹션
function ClaudeSdkSettings({ draft, setDraft, setMessage, t }: {
  draft: Partial<ProviderConfig>;
  setDraft: React.Dispatch<React.SetStateAction<Partial<ProviderConfig>>>;
  setMessage: React.Dispatch<React.SetStateAction<{ type: 'success' | 'error'; text: string } | null>>;
  t: (key: string) => string;
}) {
  const isSDKMode = draft.mode === 'sdk';
  const sdkOpts = draft.sdk_options ?? {};

  const updateSdkOption = (key: keyof ClaudeSdkOptions, value: unknown) => {
    setDraft((prev) => ({
      ...prev,
      sdk_options: { ...prev.sdk_options, [key]: value },
    }));
    setMessage(null);
  };

  const labelCls = 'text-xs text-gray-500 dark:text-gray-400 block mb-1.5';
  const inputCls = 'w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200';

  return (
    <div className="space-y-4 border-t border-dashed border-gray-300 dark:border-gray-700 pt-4">
      {/* 실행 모드 토글 */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
            {t('providers.executionMode')}
          </p>
          <p className="text-[10px] text-gray-400 dark:text-gray-600 mt-0.5">
            {t('providers.sdkNote')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium ${!isSDKMode ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 dark:text-gray-600'}`}>
            {t('providers.modeCli')}
          </span>
          <button
            onClick={() => {
              setDraft((prev) => ({ ...prev, mode: isSDKMode ? 'cli' : 'sdk' }));
              setMessage(null);
            }}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              isSDKMode ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                isSDKMode ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
          <span className={`text-xs font-medium ${isSDKMode ? 'text-purple-600 dark:text-purple-400' : 'text-gray-400 dark:text-gray-600'}`}>
            {t('providers.modeSdk')}
          </span>
        </div>
      </div>

      {/* SDK 옵션 (SDK 모드일 때만 표시) */}
      {isSDKMode && (
        <div className="space-y-3 pl-3 border-l-2 border-purple-300 dark:border-purple-600/40">
          <p className="text-xs font-semibold text-purple-600 dark:text-purple-400 uppercase tracking-wider">
            {t('providers.sdkOptions')}
          </p>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>{t('providers.sdkMaxTurns')}</label>
              <input
                type="number"
                min="1"
                max="100"
                value={sdkOpts.max_turns ?? 50}
                onChange={(e) => updateSdkOption('max_turns', parseInt(e.target.value) || 50)}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>{t('providers.sdkPermissionMode')}</label>
              <select
                value={sdkOpts.permission_mode ?? 'bypassPermissions'}
                onChange={(e) => updateSdkOption('permission_mode', e.target.value)}
                className={inputCls}
              >
                <option value="default">default</option>
                <option value="acceptEdits">acceptEdits</option>
                <option value="bypassPermissions">bypassPermissions</option>
                <option value="plan">plan</option>
                <option value="dontAsk">dontAsk</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>{t('providers.sdkMaxBudgetUsd')}</label>
              <input
                type="number"
                min="0"
                step="0.1"
                value={sdkOpts.max_budget_usd ?? ''}
                onChange={(e) => updateSdkOption('max_budget_usd', e.target.value ? parseFloat(e.target.value) : undefined)}
                placeholder="unlimited"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>
                {t('providers.sdkSessionTtl')}
                {sdkOpts.session_ttl_ms ? (
                  <span className="text-gray-400 dark:text-gray-600 ml-1">
                    ({(sdkOpts.session_ttl_ms / 60000).toFixed(0)}min)
                  </span>
                ) : null}
              </label>
              <input
                type="number"
                min="60000"
                step="60000"
                value={sdkOpts.session_ttl_ms ?? 1800000}
                onChange={(e) => updateSdkOption('session_ttl_ms', parseInt(e.target.value) || 1800000)}
                className={inputCls}
              />
            </div>
          </div>

          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
              <ToggleSwitch
                enabled={sdkOpts.enable_session_reuse !== false}
                onToggle={() => updateSdkOption('enable_session_reuse', sdkOpts.enable_session_reuse === false)}
              />
              {t('providers.sdkSessionReuse')}
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
              <ToggleSwitch
                enabled={sdkOpts.persist_session === true}
                onToggle={() => updateSdkOption('persist_session', !sdkOpts.persist_session)}
              />
              {t('providers.sdkPersistSession')}
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

// Codex 프로바이더 전용: App Server 모드 설정 섹션
function CodexAppServerSettings({ draft, setDraft, setMessage, t }: {
  draft: Partial<ProviderConfig>;
  setDraft: React.Dispatch<React.SetStateAction<Partial<ProviderConfig>>>;
  setMessage: React.Dispatch<React.SetStateAction<{ type: 'success' | 'error'; text: string } | null>>;
  t: (key: string) => string;
}) {
  const isAppServerMode = draft.mode === 'app-server';
  const opts = draft.app_server_options ?? {};

  const updateOption = (key: keyof CodexAppServerOptions, value: unknown) => {
    setDraft((prev) => ({
      ...prev,
      app_server_options: { ...prev.app_server_options, [key]: value },
    }));
    setMessage(null);
  };

  const labelCls = 'text-xs text-gray-500 dark:text-gray-400 block mb-1.5';
  const inputCls = 'w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200';

  return (
    <div className="space-y-4 border-t border-dashed border-gray-300 dark:border-gray-700 pt-4">
      {/* 실행 모드 토글 */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
            {t('providers.executionMode')}
          </p>
          <p className="text-[10px] text-gray-400 dark:text-gray-600 mt-0.5">
            {t('providers.appServerNote')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium ${!isAppServerMode ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 dark:text-gray-600'}`}>
            {t('providers.modeCli')}
          </span>
          <button
            onClick={() => {
              setDraft((prev) => ({ ...prev, mode: isAppServerMode ? 'cli' : 'app-server' }));
              setMessage(null);
            }}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              isAppServerMode ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                isAppServerMode ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
          <span className={`text-xs font-medium ${isAppServerMode ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-600'}`}>
            {t('providers.modeAppServer')}
          </span>
        </div>
      </div>

      {/* App Server 옵션 (App Server 모드일 때만 표시) */}
      {isAppServerMode && (
        <div className="space-y-3 pl-3 border-l-2 border-emerald-300 dark:border-emerald-600/40">
          <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">
            {t('providers.appServerOptions')}
          </p>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>{t('providers.appServerTransport')}</label>
              <select
                value={opts.transport ?? 'stdio'}
                onChange={(e) => updateOption('transport', e.target.value)}
                className={inputCls}
              >
                <option value="stdio">stdio</option>
                <option value="websocket">websocket (experimental)</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>{t('providers.appServerMaxTurns')}</label>
              <input
                type="number"
                min="1"
                max="100"
                value={opts.max_turns ?? ''}
                onChange={(e) => updateOption('max_turns', e.target.value ? parseInt(e.target.value) : undefined)}
                placeholder="unlimited"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>
                {t('providers.appServerSessionTtl')}
                {opts.session_ttl_ms ? (
                  <span className="text-gray-400 dark:text-gray-600 ml-1">
                    ({(opts.session_ttl_ms / 60000).toFixed(0)}min)
                  </span>
                ) : null}
              </label>
              <input
                type="number"
                min="60000"
                step="60000"
                value={opts.session_ttl_ms ?? 1800000}
                onChange={(e) => updateOption('session_ttl_ms', parseInt(e.target.value) || 1800000)}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>{t('providers.appServerMaxRestarts')}</label>
              <input
                type="number"
                min="0"
                max="20"
                value={opts.max_restart_count ?? 5}
                onChange={(e) => updateOption('max_restart_count', parseInt(e.target.value) || 5)}
                className={inputCls}
              />
            </div>
          </div>

          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
              <ToggleSwitch
                enabled={opts.enable_session_reuse !== false}
                onToggle={() => updateOption('enable_session_reuse', opts.enable_session_reuse === false)}
              />
              {t('providers.appServerSessionReuse')}
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
              <ToggleSwitch
                enabled={opts.auto_restart !== false}
                onToggle={() => updateOption('auto_restart', opts.auto_restart === false)}
              />
              {t('providers.appServerAutoRestart')}
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

function ToggleSwitch({
  enabled,
  onToggle,
  disabled,
}: {
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        disabled ? 'opacity-50 cursor-not-allowed' : ''
      } ${enabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`}
      title={enabled ? 'Disable' : 'Enable'}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          enabled ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

// HTTP 프로바이더 카드
function HttpProviderCard({
  hp, expanded, onToggle, draft, updateDraft,
  saving, testing, testResult, message,
  onSave, onDelete, onTest, t,
}: {
  hp: HttpProviderInfo;
  expanded: boolean;
  onToggle: () => void;
  draft: Partial<ProviderConfig>;
  updateDraft: (field: keyof ProviderConfig, value: string | number | boolean) => void;
  saving: boolean;
  testing: string | null;
  testResult: ProviderTestResult | null;
  message: { type: 'success' | 'error'; text: string } | null;
  onSave: () => void;
  onDelete: () => void;
  onTest: () => void;
  t: (key: string) => string;
}) {
  const labelCls = 'text-xs text-gray-500 dark:text-gray-400 block mb-1.5';
  const inputCls = 'w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm';

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700/50 shadow-sm overflow-hidden">
      {/* 헤더 */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50"
        onClick={onToggle}
      >
        <span className={`w-2 h-2 rounded-full ${hp.config.enabled ? 'bg-purple-500' : 'bg-gray-400'}`} />
        <span className="font-medium text-sm text-gray-900 dark:text-gray-100">{hp.config.display_name || hp.name}</span>
        <span className="text-xs text-purple-500 dark:text-purple-400 border border-purple-300 dark:border-purple-600 rounded px-1.5 py-0.5">
          {t('providers.httpType')}
        </span>
        <span className="text-xs text-gray-400 dark:text-gray-500 font-mono">{hp.config.base_url}</span>
        <div className="flex-1" />
        <span className="text-xs text-gray-400">{expanded ? '▲' : '▼'}</span>
      </div>

      {/* 확장 내용 */}
      {expanded && (
        <div className="px-4 py-3 border-t border-gray-100 dark:border-gray-800 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>{t('providers.baseUrl')}</label>
              <input
                type="text"
                value={(draft as Record<string, unknown>).base_url as string ?? hp.config.base_url}
                onChange={(e) => updateDraft('base_url' as keyof ProviderConfig, e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>{t('providers.apiKey')}</label>
              <input
                type="password"
                value={(draft as Record<string, unknown>).api_key as string ?? hp.config.api_key ?? ''}
                onChange={(e) => updateDraft('api_key' as keyof ProviderConfig, e.target.value)}
                placeholder={t('providers.apiKeyPlaceholder')}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>{t('providers.defaultModel')}</label>
              <input
                type="text"
                value={(draft as Record<string, unknown>).default_model as string ?? hp.config.default_model}
                onChange={(e) => updateDraft('default_model' as keyof ProviderConfig, e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>{t('providers.displayName')}</label>
              <input
                type="text"
                value={(draft as Record<string, unknown>).display_name as string ?? hp.config.display_name}
                onChange={(e) => updateDraft('display_name' as keyof ProviderConfig, e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>{t('providers.maxConcurrent')}</label>
              <input
                type="number"
                min="1"
                max="50"
                value={(draft as Record<string, unknown>).max_concurrent as number ?? hp.config.max_concurrent}
                onChange={(e) => updateDraft('max_concurrent' as keyof ProviderConfig, parseInt(e.target.value) || 1)}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>{t('providers.timeout')}</label>
              <input
                type="number"
                min="1000"
                value={(draft as Record<string, unknown>).timeout_ms as number ?? hp.config.timeout_ms}
                onChange={(e) => updateDraft('timeout_ms' as keyof ProviderConfig, parseInt(e.target.value) || 30000)}
                className={inputCls}
              />
            </div>
          </div>

          {/* 테스트 결과 */}
          {testResult && (
            <div className={`px-3 py-2 rounded text-xs ${
              testResult.success
                ? 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400'
                : 'bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400'
            }`}>
              {testResult.success
                ? `✓ ${testResult.response?.substring(0, 100)} (${testResult.latencyMs}ms)`
                : `✗ ${testResult.error}`
              }
            </div>
          )}

          {message && (
            <div className={`px-3 py-2 rounded text-xs ${
              message.type === 'success'
                ? 'bg-green-50 dark:bg-green-500/10 text-green-600'
                : 'bg-red-50 dark:bg-red-500/10 text-red-600'
            }`}>
              {message.text}
            </div>
          )}

          {/* 액션 버튼 */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={onSave}
              disabled={saving}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-xs font-medium text-white"
            >
              {saving ? t('common.saving') : t('common.save')}
            </button>
            <button
              onClick={onTest}
              disabled={!!testing}
              className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded text-xs font-medium text-white"
            >
              {testing === hp.name ? t('providers.testing') : t('providers.test')}
            </button>
            <button
              onClick={onToggle}
              className="px-4 py-1.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded text-xs font-medium"
            >
              {t('common.cancel')}
            </button>
            <div className="flex-1" />
            <button
              onClick={onDelete}
              className="px-4 py-1.5 bg-red-600 hover:bg-red-700 rounded text-xs font-medium text-white"
            >
              {t('common.delete')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// HTTP 프로바이더 추가 폼
function AddHttpProviderForm({
  draft, setDraft, error, saving, onSave, onCancel, t,
}: {
  draft: { name: string } & Partial<HttpProviderConfig>;
  setDraft: React.Dispatch<React.SetStateAction<{ name: string } & Partial<HttpProviderConfig>>>;
  error: string | null;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  t: (key: string) => string;
}) {
  const labelCls = 'text-xs text-gray-500 dark:text-gray-400 block mb-1.5';
  const inputCls = 'w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm';
  const [localTestResult, setLocalTestResult] = useState<ProviderTestResult | null>(null);
  const [localTesting, setLocalTesting] = useState(false);

  const handleTestBeforeRegister = async () => {
    setLocalTesting(true);
    setLocalTestResult(null);
    try {
      const result = await testHttpProvider(draft);
      setLocalTestResult(result);
    } catch (e) {
      setLocalTestResult({ success: false, error: e instanceof Error ? e.message : String(e), latencyMs: 0 });
    } finally {
      setLocalTesting(false);
    }
  };

  return (
    <div className="bg-purple-50/50 dark:bg-purple-500/5 border border-purple-200 dark:border-purple-500/20 rounded-lg px-4 py-4 space-y-4">
      {/* 가이드 */}
      <div className="px-3 py-2 rounded bg-purple-100/50 dark:bg-purple-500/10 border border-purple-200 dark:border-purple-500/20 text-xs text-purple-700 dark:text-purple-300">
        {t('providers.httpGuide')}
      </div>

      {error && (
        <div className="px-3 py-2 rounded bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 text-xs text-red-600">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>{t('providers.name')}</label>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))}
            placeholder="mlx-local"
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>{t('providers.displayName')}</label>
          <input
            type="text"
            value={draft.display_name ?? ''}
            onChange={(e) => setDraft((p) => ({ ...p, display_name: e.target.value }))}
            placeholder="MLX Local"
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>{t('providers.baseUrl')}</label>
          <input
            type="text"
            value={draft.base_url ?? ''}
            onChange={(e) => setDraft((p) => ({ ...p, base_url: e.target.value }))}
            placeholder={t('providers.baseUrlPlaceholder')}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>{t('providers.apiKey')}</label>
          <input
            type="password"
            value={draft.api_key ?? ''}
            onChange={(e) => setDraft((p) => ({ ...p, api_key: e.target.value }))}
            placeholder={t('providers.apiKeyPlaceholder')}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>{t('providers.defaultModel')}</label>
          <input
            type="text"
            value={draft.default_model ?? ''}
            onChange={(e) => setDraft((p) => ({ ...p, default_model: e.target.value }))}
            placeholder="llama3"
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>{t('providers.maxConcurrent')}</label>
          <input
            type="number"
            min="1"
            max="50"
            value={draft.max_concurrent ?? 5}
            onChange={(e) => setDraft((p) => ({ ...p, max_concurrent: parseInt(e.target.value) || 5 }))}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>{t('providers.timeout')}</label>
          <input
            type="number"
            min="1000"
            value={draft.timeout_ms ?? 300000}
            onChange={(e) => setDraft((p) => ({ ...p, timeout_ms: parseInt(e.target.value) || 300000 }))}
            className={inputCls}
          />
        </div>
      </div>

      {/* 테스트 결과 */}
      {localTestResult && (
        <div className={`px-3 py-2 rounded text-xs ${
          localTestResult.success
            ? 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400'
            : 'bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400'
        }`}>
          {localTestResult.success
            ? `✓ ${localTestResult.response?.substring(0, 100)} (${localTestResult.latencyMs}ms)`
            : `✗ ${localTestResult.error}`
          }
        </div>
      )}

      {/* 버튼 */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={handleTestBeforeRegister}
          disabled={localTesting || !draft.base_url}
          className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded text-xs font-medium text-white"
        >
          {localTesting ? t('providers.testing') : t('providers.testBefore')}
        </button>
        <button
          onClick={onSave}
          disabled={saving || !draft.name || !draft.base_url}
          className="px-4 py-1.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 rounded text-xs font-medium text-white"
        >
          {saving ? t('common.saving') : t('providers.addHttp')}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-1.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded text-xs font-medium"
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
