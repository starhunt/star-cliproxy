import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from '../i18n/context';
import {
  fetchModelMappings,
  createModelMapping,
  updateModelMapping,
  deleteModelMapping,
  testModel,
  fetchProviders,
  type ModelMapping,
  type ReasoningEffort,
  type TestModelResult,
} from '../api/client';

type ReasoningEffortValue = ReasoningEffort | '';

const REASONING_EFFORT_OPTIONS: ReasoningEffortValue[] = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

interface MappingFormState {
  alias: string;
  provider: string;
  actual_model: string;
  reasoning_effort: ReasoningEffortValue;
  priority: number;
}

const EMPTY_FORM: MappingFormState = {
  alias: '',
  provider: 'claude',
  actual_model: '',
  reasoning_effort: '',
  priority: 0,
};

export default function ModelMappingsPage() {
  const { t } = useTranslation();
  const [mappings, setMappings] = useState<ModelMapping[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<MappingFormState>({ ...EMPTY_FORM });
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestModelResult | null>(null);
  const [rowTesting, setRowTesting] = useState<string | null>(null);
  const [rowTestResult, setRowTestResult] = useState<{ id: string; result: TestModelResult } | null>(null);
  const [providerNames, setProviderNames] = useState<string[]>(['claude', 'codex', 'copilot', 'gemini']);

  // 검색/필터
  const [searchQuery, setSearchQuery] = useState('');
  const [filterProvider, setFilterProvider] = useState<string>('');
  const [filterEffort, setFilterEffort] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<'' | 'on' | 'off'>('');

  const filteredMappings = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return mappings.filter((m) => {
      if (filterProvider && m.provider !== filterProvider) return false;
      if (filterEffort) {
        const cur = m.reasoningEffort ?? '';
        if (filterEffort === '__default__' ? cur !== '' : cur !== filterEffort) return false;
      }
      if (filterStatus === 'on' && !m.enabled) return false;
      if (filterStatus === 'off' && m.enabled) return false;
      if (q) {
        const hay = `${m.alias} ${m.actualModel} ${m.displayName ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [mappings, searchQuery, filterProvider, filterEffort, filterStatus]);

  const filtersActive = !!(searchQuery || filterProvider || filterEffort || filterStatus);
  const clearFilters = () => {
    setSearchQuery('');
    setFilterProvider('');
    setFilterEffort('');
    setFilterStatus('');
  };

  // AbortController refs
  const formTestAbortRef = useRef<AbortController | null>(null);
  const rowTestAbortRef = useRef<AbortController | null>(null);

  const load = () => {
    fetchModelMappings().then(setMappings).catch((e) => setError(e.message));
  };

  useEffect(load, []);

  // 프로바이더 목록 동적 로드 (플러그인 포함)
  useEffect(() => {
    fetchProviders()
      .then((providers) => setProviderNames(providers.map((p) => p.name)))
      .catch(() => { /* 실패 시 기본값 유지 */ });
  }, []);

  // 컴포넌트 언마운트 시 정리
  useEffect(() => {
    return () => {
      formTestAbortRef.current?.abort();
      rowTestAbortRef.current?.abort();
    };
  }, []);

  // 폼 테스트 취소
  const cancelFormTest = useCallback(() => {
    if (formTestAbortRef.current) {
      formTestAbortRef.current.abort();
      formTestAbortRef.current = null;
    }
    setTesting(false);
  }, []);

  // 행 테스트 취소
  const cancelRowTest = useCallback(() => {
    if (rowTestAbortRef.current) {
      rowTestAbortRef.current.abort();
      rowTestAbortRef.current = null;
    }
    setRowTesting(null);
  }, []);

  // 폼 닫기 (테스트 중이면 취소)
  const closeForm = useCallback(() => {
    cancelFormTest();
    setShowForm(false);
    setEditingId(null);
    setTestResult(null);
    setForm({ ...EMPTY_FORM });
  }, [cancelFormTest]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    cancelFormTest();
    // 빈 문자열 → null(unset), 값이 있으면 그대로 전송
    const reasoningEffort: ReasoningEffort | null = form.reasoning_effort === ''
      ? null
      : form.reasoning_effort;
    const payload = {
      alias: form.alias,
      provider: form.provider,
      actual_model: form.actual_model,
      reasoning_effort: reasoningEffort,
      priority: form.priority,
    };
    try {
      if (editingId) {
        await updateModelMapping(editingId, payload);
      } else {
        await createModelMapping(payload);
      }
      closeForm();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  const handleEdit = (m: ModelMapping) => {
    cancelFormTest();
    setEditingId(m.id);
    setForm({
      alias: m.alias,
      provider: m.provider,
      actual_model: m.actualModel,
      reasoning_effort: m.reasoningEffort ?? '',
      priority: m.priority,
    });
    setShowForm(true);
    setTestResult(null);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this mapping?')) return;
    await deleteModelMapping(id);
    load();
  };

  const handleToggle = async (m: ModelMapping) => {
    await updateModelMapping(m.id, { enabled: !m.enabled });
    load();
  };

  // 폼에서 테스트
  const handleTest = async () => {
    if (!form.provider || !form.actual_model) {
      setTestResult({ success: false, provider: form.provider, model: form.actual_model, error: 'Provider and Actual Model are required.', latencyMs: 0 });
      return;
    }

    cancelFormTest();
    const controller = new AbortController();
    formTestAbortRef.current = controller;
    setTesting(true);
    setTestResult(null);

    try {
      const result = await testModel(form.provider, form.actual_model, controller.signal);
      if (!controller.signal.aborted) {
        setTestResult(result);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setTestResult({ success: false, provider: form.provider, model: form.actual_model, error: err instanceof Error ? err.message : 'Test failed', latencyMs: 0 });
    } finally {
      if (!controller.signal.aborted) {
        setTesting(false);
      }
      if (formTestAbortRef.current === controller) {
        formTestAbortRef.current = null;
      }
    }
  };

  // 테이블 행에서 테스트
  const handleRowTest = async (m: ModelMapping) => {
    cancelRowTest();
    const controller = new AbortController();
    rowTestAbortRef.current = controller;
    setRowTesting(m.id);
    setRowTestResult(null);

    try {
      const result = await testModel(m.provider, m.actualModel, controller.signal);
      if (!controller.signal.aborted) {
        setRowTestResult({ id: m.id, result });
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setRowTestResult({ id: m.id, result: { success: false, provider: m.provider, model: m.actualModel, error: err instanceof Error ? err.message : 'Test failed', latencyMs: 0 } });
    } finally {
      if (!controller.signal.aborted) {
        setRowTesting(null);
      }
      if (rowTestAbortRef.current === controller) {
        rowTestAbortRef.current = null;
      }
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('models.title')}</h2>
        <button
          onClick={() => {
            if (showForm) { closeForm(); }
            else {
              cancelFormTest();
              setShowForm(true);
              setEditingId(null);
              setForm({ ...EMPTY_FORM });
              setTestResult(null);
            }
          }}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm text-white transition-colors"
        >
          {t('models.addMapping')}
        </button>
      </div>

      {error && <p className="text-red-500 dark:text-red-400 text-sm">{error}</p>}

      {/* 폼 */}
      {showForm && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 space-y-3">
          <form onSubmit={handleSubmit}>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">{t('models.aliasLabel')}</label>
                <input
                  value={form.alias}
                  onChange={(e) => setForm({ ...form, alias: e.target.value })}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
                  placeholder="gpt-4"
                  required
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">{t('models.providerLabel')}</label>
                <select
                  value={form.provider}
                  onChange={(e) => { setForm({ ...form, provider: e.target.value }); setTestResult(null); }}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
                >
                  {providerNames.map((name) => (
                    <option key={name} value={name}>{name.charAt(0).toUpperCase() + name.slice(1)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">{t('models.actualModelLabel')}</label>
                <input
                  value={form.actual_model}
                  onChange={(e) => { setForm({ ...form, actual_model: e.target.value }); setTestResult(null); }}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
                  placeholder="claude-sonnet-4-6"
                  required
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">
                  {t('models.reasoningEffortLabel')}
                </label>
                <select
                  value={form.reasoning_effort}
                  onChange={(e) => setForm({ ...form, reasoning_effort: e.target.value as ReasoningEffortValue })}
                  disabled={form.provider === 'gemini'}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  title={form.provider === 'gemini' ? t('models.reasoningEffortUnsupported') : undefined}
                >
                  {REASONING_EFFORT_OPTIONS.map((value) => (
                    <option key={value || 'default'} value={value}>
                      {value === '' ? t('models.reasoningEffortDefault') : value}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">{t('models.priorityLabel')}</label>
                <input
                  type="number"
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: parseInt(e.target.value) || 0 })}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
                />
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              {testing ? (
                <button
                  type="button"
                  onClick={cancelFormTest}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded text-sm text-white transition-colors"
                >
                  {t('common.cancelTest')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={!form.provider || !form.actual_model}
                  className="px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed rounded text-sm text-white transition-colors"
                >
                  {t('common.test')}
                </button>
              )}
              <button type="submit" disabled={testing} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded text-sm text-white">
                {editingId ? t('common.update') : t('common.create')}
              </button>
              <button type="button" onClick={closeForm} className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded text-sm text-gray-700 dark:text-gray-200">
                {t('common.cancel')}
              </button>
            </div>
          </form>

          {/* 테스트 진행 */}
          {testing && (
            <div className="mt-3 px-4 py-3 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                  <span className="inline-block w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                  {t('models.testing')} {form.provider} / {form.actual_model} ...
                </div>
                <button
                  onClick={cancelFormTest}
                  className="text-xs text-gray-400 dark:text-gray-500 hover:text-red-400 transition-colors"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}

          {/* 테스트 결과 */}
          {testResult && (
            <div className={`mt-3 px-4 py-3 rounded-lg border ${testResult.success ? 'bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/30' : 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30'}`}>
              <div className="flex items-center justify-between mb-1">
                <span className={`text-sm font-semibold ${testResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                  {testResult.success ? t('models.testPassed') : t('models.testFailed')}
                </span>
                <span className="text-xs text-gray-400 dark:text-gray-500">{testResult.latencyMs}ms</span>
              </div>
              {testResult.success && testResult.response && (
                <div className="mt-1">
                  <p className="text-sm text-gray-700 dark:text-gray-300">
                    {t('models.response')}: <code className="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-green-600 dark:text-green-300">{testResult.response}</code>
                  </p>
                  {isImageUrl(testResult.response) && (
                    <img
                      src={testResult.response.trim()}
                      alt="Generated image"
                      className="mt-2 max-w-sm rounded-lg border border-gray-200 dark:border-gray-700"
                      loading="lazy"
                    />
                  )}
                </div>
              )}
              {testResult.success && testResult.usage && (
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  {t('models.tokens')}: {testResult.usage.promptTokens} {t('models.tokensIn')} / {testResult.usage.completionTokens} {t('models.tokensOut')}
                </p>
              )}
              {!testResult.success && testResult.error && (
                <p className="text-sm text-red-500 dark:text-red-300 mt-1">{testResult.error}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* 행 테스트 결과 배너 */}
      {rowTesting && (
        <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <span className="inline-block w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
              {t('models.testing')} {mappings.find(m => m.id === rowTesting)?.provider} / {mappings.find(m => m.id === rowTesting)?.actualModel} ...
            </div>
            <button
              onClick={cancelRowTest}
              className="text-xs text-gray-400 dark:text-gray-500 hover:text-red-400 transition-colors"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
      {rowTestResult && (
        <div className={`px-4 py-3 rounded-lg border ${rowTestResult.result.success ? 'bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/30' : 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30'}`}>
          <div className="flex items-center justify-between">
            <div>
              <span className={`text-sm font-semibold ${rowTestResult.result.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {rowTestResult.result.success ? t('models.testPassed') : t('models.testFailed')}
              </span>
              <span className="text-sm text-gray-500 dark:text-gray-400 ml-2">
                {rowTestResult.result.provider} / {rowTestResult.result.model}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-400 dark:text-gray-500">{rowTestResult.result.latencyMs}ms</span>
              <button onClick={() => setRowTestResult(null)} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-xs">{t('common.dismiss')}</button>
            </div>
          </div>
          {rowTestResult.result.success && rowTestResult.result.response && (
            <p className="text-sm text-gray-700 dark:text-gray-300 mt-1">
              {t('models.response')}: <code className="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-green-600 dark:text-green-300">{rowTestResult.result.response}</code>
            </p>
          )}
          {!rowTestResult.result.success && rowTestResult.result.error && (
            <p className="text-sm text-red-500 dark:text-red-300 mt-1">{rowTestResult.result.error}</p>
          )}
        </div>
      )}

      {/* 검색/필터 툴바 */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('models.searchPlaceholder')}
            className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded pl-9 pr-3 py-2 text-sm text-gray-800 dark:text-gray-200"
          />
        </div>
        <select
          value={filterProvider}
          onChange={(e) => setFilterProvider(e.target.value)}
          className="bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
          title={t('models.filterProvider')}
        >
          <option value="">{t('models.filterAllProviders')}</option>
          {providerNames.map((name) => (
            <option key={name} value={name}>{name.charAt(0).toUpperCase() + name.slice(1)}</option>
          ))}
        </select>
        <select
          value={filterEffort}
          onChange={(e) => setFilterEffort(e.target.value)}
          className="bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
          title={t('models.filterEffort')}
        >
          <option value="">{t('models.filterAllEfforts')}</option>
          <option value="__default__">{t('models.reasoningEffortDefault')}</option>
          {(['low', 'medium', 'high', 'xhigh', 'max'] as const).map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as '' | 'on' | 'off')}
          className="bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
          title={t('models.filterStatus')}
        >
          <option value="">{t('models.filterAllStatuses')}</option>
          <option value="on">{t('common.on')}</option>
          <option value="off">{t('common.off')}</option>
        </select>
        <div className="text-xs text-gray-500 dark:text-gray-400 ml-auto flex items-center gap-2">
          <span>{t('models.filterCount', { shown: String(filteredMappings.length), total: String(mappings.length) })}</span>
          {filtersActive && (
            <button
              onClick={clearFilters}
              className="text-gray-400 dark:text-gray-500 hover:text-blue-500 dark:hover:text-blue-400 underline"
            >
              {t('models.clearFilters')}
            </button>
          )}
        </div>
      </div>

      {/* 테이블 */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-800 text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wider">
              <th className="text-left px-4 py-3">{t('models.alias')}</th>
              <th className="text-left px-4 py-3">{t('models.provider')}</th>
              <th className="text-left px-4 py-3">{t('models.actualModel')}</th>
              <th className="text-left px-4 py-3">{t('models.reasoningEffort')}</th>
              <th className="text-left px-4 py-3">{t('models.priority')}</th>
              <th className="text-left px-4 py-3">{t('models.status')}</th>
              <th className="text-right px-4 py-3">{t('models.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filteredMappings.map((m) => (
              <tr key={m.id} className="border-b border-gray-100 dark:border-gray-800/50 hover:bg-gray-50 dark:hover:bg-gray-800/30">
                <td className="px-4 py-3 font-mono text-blue-600 dark:text-blue-400">{m.alias}</td>
                <td className="px-4 py-3 capitalize text-gray-700 dark:text-gray-300">{m.provider}</td>
                <td className="px-4 py-3 font-mono text-gray-500 dark:text-gray-300">{m.actualModel}</td>
                <td className="px-4 py-3 text-xs">
                  {m.reasoningEffort ? (
                    <span className="px-2 py-0.5 rounded bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-300 font-mono">
                      {m.reasoningEffort}
                    </span>
                  ) : (
                    <span className="text-gray-300 dark:text-gray-600">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-400 dark:text-gray-500">{m.priority}</td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => handleToggle(m)}
                    className={`px-2 py-0.5 rounded text-xs ${m.enabled ? 'bg-green-100 dark:bg-green-500/20 text-green-600 dark:text-green-400' : 'bg-gray-200 dark:bg-gray-700 text-gray-500'}`}
                  >
                    {m.enabled ? t('common.on') : t('common.off')}
                  </button>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    {rowTesting === m.id ? (
                      <button
                        onClick={cancelRowTest}
                        title={t('common.cancel')}
                        aria-label={t('common.cancel')}
                        className="p-1.5 rounded text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <rect x="6" y="6" width="12" height="12" rx="1" />
                        </svg>
                      </button>
                    ) : (
                      <button
                        onClick={() => handleRowTest(m)}
                        title={t('common.test')}
                        aria-label={t('common.test')}
                        className="p-1.5 rounded text-gray-400 hover:text-amber-500 dark:hover:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-500/10 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l14 9-14 9V3z" />
                        </svg>
                      </button>
                    )}
                    <button
                      onClick={() => handleEdit(m)}
                      title={t('common.edit')}
                      aria-label={t('common.edit')}
                      className="p-1.5 rounded text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDelete(m.id)}
                      title={t('common.delete')}
                      aria-label={t('common.delete')}
                      className="p-1.5 rounded text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a2 2 0 012-2h2a2 2 0 012 2v3" />
                      </svg>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {filteredMappings.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400 dark:text-gray-600">
                  {mappings.length === 0
                    ? t('models.noMappings')
                    : t('models.noMatches')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function isImageUrl(text: string): boolean {
  const trimmed = text.trim();
  try {
    const url = new URL(trimmed);
    return /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(url.pathname)
      || url.hostname.includes('blob.core.windows.net');
  } catch {
    return false;
  }
}
