import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from '../i18n/context';
import {
  fetchModelMappings,
  createModelMapping,
  updateModelMapping,
  deleteModelMapping,
  testModel,
  fetchProviders,
  fetchProviderConfig,
  fetchCodexCliDefaults,
  type CodexCliDefaults,
  type ModelMapping,
  type ProviderConfig,
  type ProviderOverrides,
  type ReasoningEffort,
  type TestModelResult,
} from '../api/client';

type ReasoningEffortValue = ReasoningEffort | '';

const REASONING_EFFORT_OPTIONS: ReasoningEffortValue[] = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

// 빈/기본값 표시: '' = 프로바이더 기본값 사용, 'true'/'false' = 명시적 오버라이드
type TriState = '' | 'true' | 'false';

interface MappingFormState {
  alias: string;
  provider: string;
  actual_model: string;
  reasoning_effort: ReasoningEffortValue;
  // ''=상속(전역 default), 'true'=노출, 'false'=숨김
  include_reasoning: TriState;
  // 백엔드 비표준 필드 JSON (chat_template_kwargs / top_k / think 등). 빈 문자열 = 미설정.
  extra_body_text: string;
  priority: number;
  // codex provider 한정 오버라이드 — 다른 provider 선택 시 무시
  override_ephemeral: TriState;
  override_enable_session_reuse: TriState;
  override_session_ttl_ms: string;       // 빈 문자열 = 기본값 따름
  override_extra_args: string;            // 줄바꿈 구분
  override_timeout_ms: string;
  override_working_dir: string;
}

// codex 프로바이더가 admin API에서 응답하지 않을 때 사용할 폴백 기본값.
// 서버 상수와 동기 유지: cli_options.ephemeral=true (DEFAULT in codex-provider),
// enable_session_reuse=false, session_ttl_ms=1800000 (CodexCliSessionManager DEFAULT_SESSION_TTL_MS).
const KNOWN_CODEX_DEFAULTS = {
  cli_options: {
    ephemeral: true,
    enable_session_reuse: false,
    session_ttl_ms: 1800000,
  },
} as const;

const EMPTY_FORM: MappingFormState = {
  alias: '',
  provider: 'claude',
  actual_model: '',
  reasoning_effort: '',
  include_reasoning: '',
  extra_body_text: '',
  priority: 0,
  override_ephemeral: '',
  override_enable_session_reuse: '',
  override_session_ttl_ms: '',
  override_extra_args: '',
  override_timeout_ms: '',
  override_working_dir: '',
};

// 폼 상태 → API payload용 ProviderOverrides | null 빌더.
// 빈/미설정 필드는 omit, 모든 필드가 비어있으면 null 반환.
function buildOverridesPayload(form: MappingFormState): ProviderOverrides | null {
  // codex가 아니면 overrides 미적용
  if (form.provider !== 'codex') return null;
  const out: ProviderOverrides = {};
  const cli: NonNullable<ProviderOverrides['cli_options']> = {};
  if (form.override_ephemeral) cli.ephemeral = form.override_ephemeral === 'true';
  if (form.override_enable_session_reuse) cli.enable_session_reuse = form.override_enable_session_reuse === 'true';
  if (form.override_session_ttl_ms.trim()) {
    const n = Number(form.override_session_ttl_ms);
    if (Number.isFinite(n) && n > 0) cli.session_ttl_ms = n;
  }
  if (Object.keys(cli).length > 0) out.cli_options = cli;
  const args = form.override_extra_args.split('\n').map((a) => a.trim()).filter(Boolean);
  if (args.length > 0) out.extra_args = args;
  if (form.override_timeout_ms.trim()) {
    const n = Number(form.override_timeout_ms);
    if (Number.isFinite(n) && n > 0) out.timeout_ms = n;
  }
  if (form.override_working_dir.trim()) out.working_dir = form.override_working_dir.trim();
  return Object.keys(out).length > 0 ? out : null;
}

// DB에서 받은 ProviderOverrides → 폼 상태로 복원
function applyOverridesToForm(overrides: ProviderOverrides | null): Partial<MappingFormState> {
  if (!overrides) return {};
  const cli = overrides.cli_options;
  return {
    override_ephemeral: cli?.ephemeral === undefined ? '' : (cli.ephemeral ? 'true' : 'false'),
    override_enable_session_reuse: cli?.enable_session_reuse === undefined ? '' : (cli.enable_session_reuse ? 'true' : 'false'),
    override_session_ttl_ms: cli?.session_ttl_ms !== undefined ? String(cli.session_ttl_ms) : '',
    override_extra_args: overrides.extra_args ? overrides.extra_args.join('\n') : '',
    override_timeout_ms: overrides.timeout_ms !== undefined ? String(overrides.timeout_ms) : '',
    override_working_dir: overrides.working_dir ?? '',
  };
}

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
  // ephemeral ↔ enable_session_reuse 자동 조정 알림 (3초 후 자동 해제)
  const [overrideMutexNotice, setOverrideMutexNotice] = useState(false);
  const mutexNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // codex 프로바이더의 현재 yaml effective 설정값 (폼 placeholder에 '(기본값: ...)' 표시용)
  const [codexDefaults, setCodexDefaults] = useState<ProviderConfig | null>(null);
  // ~/.codex/config.toml에서 읽은 글로벌 기본값 (reasoning_effort effective 표시용)
  const [codexCliDefaults, setCodexCliDefaults] = useState<CodexCliDefaults | null>(null);

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

  // codex 프로바이더의 effective 기본값 — Provider Overrides 폼 placeholder/배지에 사용.
  // codex 미등록/404 시에는 서버 상수와 동일한 폴백 사용 (DEFAULT 정의는 아래 KNOWN_CODEX_DEFAULTS).
  useEffect(() => {
    fetchProviderConfig('codex')
      .then(setCodexDefaults)
      .catch(() => setCodexDefaults(null));
    fetchCodexCliDefaults()
      .then(setCodexCliDefaults)
      .catch(() => setCodexCliDefaults(null));
  }, []);  // mount 시 1회 + 폼 열릴 때 별도 refresh는 아래 effect로 처리

  useEffect(() => {
    if (showForm) {
      fetchProviderConfig('codex').then(setCodexDefaults).catch(() => { /* keep last */ });
      fetchCodexCliDefaults().then(setCodexCliDefaults).catch(() => { /* keep last */ });
    }
  }, [showForm]);

  // placeholder 빌더: 실값 있으면 '(기본값: X)' 형태, 없으면 일반 '(기본값 사용)' 사용
  const defaultLabel = useCallback((value: unknown): string => {
    if (value === undefined || value === null || value === '') return t('models.overrides.useDefault');
    if (typeof value === 'boolean') return `${t('models.overrides.defaultPrefix')}: ${value ? 'true' : 'false'}`;
    if (Array.isArray(value)) {
      return value.length === 0
        ? t('models.overrides.useDefault')
        : `${t('models.overrides.defaultPrefix')}: ${value.join(' ')}`;
    }
    return `${t('models.overrides.defaultPrefix')}: ${String(value)}`;
  }, [t]);

  // 폼/기본값을 합쳐 실효값 계산. 폼 명시값 > yaml 기본값 > undefined 순.
  // ephemeral의 경우 session_reuse가 true(실효 기준)면 강제 false.
  const resolveEffectiveBool = (formVal: TriState, baseVal: boolean | undefined): boolean | undefined => {
    if (formVal === 'true') return true;
    if (formVal === 'false') return false;
    return baseVal;
  };

  // yaml fetch 실패 시 폴백 기본값 사용 (KNOWN_CODEX_DEFAULTS).
  const effectiveSessionReuseBase =
    codexDefaults?.cli_options?.enable_session_reuse ?? KNOWN_CODEX_DEFAULTS.cli_options.enable_session_reuse;
  const effectiveEphemeralBase =
    codexDefaults?.cli_options?.ephemeral ?? KNOWN_CODEX_DEFAULTS.cli_options.ephemeral;
  const effectiveSessionTtlBase =
    codexDefaults?.cli_options?.session_ttl_ms ?? KNOWN_CODEX_DEFAULTS.cli_options.session_ttl_ms;

  const effectiveSessionReuse = resolveEffectiveBool(
    form.override_enable_session_reuse,
    effectiveSessionReuseBase,
  );

  const baseEphemeral = resolveEffectiveBool(form.override_ephemeral, effectiveEphemeralBase);

  // session_reuse가 true면 서버에서 ephemeral을 자동으로 false로 강제 (codex-provider.getEffectiveConfig)
  const effectiveEphemeral = effectiveSessionReuse === true ? false : baseEphemeral;
  const ephemeralIsForced = effectiveSessionReuse === true && baseEphemeral !== false;

  // 컴포넌트 언마운트 시 정리
  useEffect(() => {
    return () => {
      formTestAbortRef.current?.abort();
      rowTestAbortRef.current?.abort();
      if (mutexNoticeTimerRef.current) clearTimeout(mutexNoticeTimerRef.current);
    };
  }, []);

  // ephemeral ↔ enable_session_reuse 상호 배제 자동 조정 핸들러.
  // 한쪽을 'true'로 바꾸면 다른 쪽이 'true'면 'false'로 자동 변경 + 알림 표시.
  // 사용자가 의도적으로 'false'/'(기본값)'를 고를 때는 알림 없음.
  const handleEphemeralChange = (next: TriState) => {
    let nextReuse = form.override_enable_session_reuse;
    let triggered = false;
    if (next === 'true' && form.override_enable_session_reuse === 'true') {
      nextReuse = 'false';
      triggered = true;
    }
    setForm({ ...form, override_ephemeral: next, override_enable_session_reuse: nextReuse });
    if (triggered) showMutexNotice();
  };

  const handleSessionReuseChange = (next: TriState) => {
    let nextEphemeral = form.override_ephemeral;
    let triggered = false;
    if (next === 'true' && form.override_ephemeral === 'true') {
      nextEphemeral = 'false';
      triggered = true;
    }
    setForm({ ...form, override_enable_session_reuse: next, override_ephemeral: nextEphemeral });
    if (triggered) showMutexNotice();
  };

  const showMutexNotice = () => {
    setOverrideMutexNotice(true);
    if (mutexNoticeTimerRef.current) clearTimeout(mutexNoticeTimerRef.current);
    mutexNoticeTimerRef.current = setTimeout(() => setOverrideMutexNotice(false), 5000);
  };

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
    const includeReasoning: boolean | null = form.include_reasoning === ''
      ? null
      : form.include_reasoning === 'true';

    // extra_body 파싱. 빈 문자열은 null, 잘못된 JSON이면 에러.
    let extraBody: Record<string, unknown> | null = null;
    const extraText = form.extra_body_text.trim();
    if (extraText) {
      try {
        const parsed = JSON.parse(extraText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setError('extra_body must be a JSON object.');
          return;
        }
        extraBody = parsed as Record<string, unknown>;
      } catch {
        setError('extra_body is not valid JSON.');
        return;
      }
    }

    const payload = {
      alias: form.alias,
      provider: form.provider,
      actual_model: form.actual_model,
      reasoning_effort: reasoningEffort,
      provider_overrides: buildOverridesPayload(form),
      include_reasoning: includeReasoning,
      extra_body: extraBody,
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
      ...EMPTY_FORM,
      alias: m.alias,
      provider: m.provider,
      actual_model: m.actualModel,
      reasoning_effort: m.reasoningEffort ?? '',
      include_reasoning: m.includeReasoning === null || m.includeReasoning === undefined
        ? ''
        : (m.includeReasoning ? 'true' : 'false'),
      extra_body_text: m.extraBody ? JSON.stringify(m.extraBody, null, 2) : '',
      priority: m.priority,
      ...applyOverridesToForm(m.providerOverrides),
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
                  {(() => {
                    // 추론 수준 effective 결정:
                    //   1) 매핑에 명시값 있으면 그 값
                    //   2) codex 프로바이더 + ~/.codex/config.toml의 model_reasoning_effort 있으면 그 값 (출처 표시)
                    //   3) 그 외에는 "CLI default"
                    if (form.reasoning_effort) {
                      return (
                        <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border border-blue-300 dark:border-blue-700">
                          {t('models.overrides.effectiveLabel')}: {form.reasoning_effort}
                        </span>
                      );
                    }
                    if (form.provider === 'codex' && codexCliDefaults?.modelReasoningEffort) {
                      return (
                        <span
                          className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-700"
                          title={`from ${codexCliDefaults.configPath}`}
                        >
                          {t('models.overrides.effectiveLabel')}: {codexCliDefaults.modelReasoningEffort} <span className="opacity-70">(~/.codex/config.toml)</span>
                        </span>
                      );
                    }
                    return (
                      <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border border-blue-300 dark:border-blue-700">
                        {t('models.overrides.effectiveLabel')}: CLI default
                      </span>
                    );
                  })()}
                </label>
                <select
                  value={form.reasoning_effort}
                  onChange={(e) => setForm({ ...form, reasoning_effort: e.target.value as ReasoningEffortValue })}
                  disabled={form.provider === 'gemini'}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  title={form.provider === 'gemini' ? t('models.reasoningEffortUnsupported') : t('models.reasoningEffortHelp')}
                >
                  {REASONING_EFFORT_OPTIONS.map((value) => (
                    <option key={value || 'default'} value={value}>
                      {value === ''
                        ? (form.provider === 'codex' && codexCliDefaults?.modelReasoningEffort
                            ? `${t('models.reasoningEffortDefault')} → ${codexCliDefaults.modelReasoningEffort}`
                            : t('models.reasoningEffortDefault'))
                        : value}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">
                  {t('models.includeReasoningLabel')}
                  <span
                    className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border border-blue-300 dark:border-blue-700"
                    title={t('models.includeReasoningHelp')}
                  >
                    {t('models.overrides.effectiveLabel')}:{' '}
                    {form.include_reasoning === '' ? 'inherit' : form.include_reasoning}
                  </span>
                </label>
                <select
                  value={form.include_reasoning}
                  onChange={(e) => setForm({ ...form, include_reasoning: e.target.value as TriState })}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
                  title={t('models.includeReasoningHelp')}
                >
                  <option value="">{t('models.includeReasoningInherit')}</option>
                  <option value="true">{t('models.includeReasoningTrue')}</option>
                  <option value="false">{t('models.includeReasoningFalse')}</option>
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">
                  {t('models.extraBodyLabel')}
                  <span className="ml-2 text-[10px] text-gray-400 dark:text-gray-500 font-normal">
                    {t('models.extraBodyHint')}
                  </span>
                </label>
                <textarea
                  value={form.extra_body_text}
                  onChange={(e) => setForm({ ...form, extra_body_text: e.target.value })}
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-xs font-mono text-gray-800 dark:text-gray-200"
                  rows={4}
                  placeholder='{"chat_template_kwargs": {"enable_thinking": false}}'
                />
                <p className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
                  {t('models.extraBodyHelp')}
                </p>
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

            {/* Provider Overrides (codex CLI 1차 지원) — 매핑 단위로 프로바이더 옵션을 덮어씀.
                빈 상태(공란/'기본값') = 프로바이더 yaml 설정 따름, 명시값 = 매핑에서 우선. */}
            {form.provider === 'codex' && (
              <details className="mt-4 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900/60">
                <summary className="px-4 py-3 text-sm font-semibold text-gray-800 dark:text-gray-100 cursor-pointer select-none hover:bg-gray-50 dark:hover:bg-gray-800/60 rounded-t-lg">
                  {t('models.overrides.title')}
                </summary>
                <div className="px-4 py-4 border-t border-gray-300 dark:border-gray-600 space-y-4">
                  <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
                    {t('models.overrides.help')}
                  </p>
                  {overrideMutexNotice && (
                    <div
                      role="alert"
                      className="px-3 py-2 bg-amber-50 dark:bg-amber-900/30 border-l-4 border-amber-500 dark:border-amber-400 rounded text-sm text-amber-900 dark:text-amber-100 flex items-start gap-2"
                    >
                      <span aria-hidden className="text-base leading-none">⚠️</span>
                      <span className="font-medium">{t('models.overrides.mutexNotice')}</span>
                    </div>
                  )}

                  {/* 세션 재사용이 effective true가 되면 클라이언트 통합 책임을 강조한다.
                      잘못 설정하면 다른 사용자의 컨텍스트가 섞일 수 있어 보안/품질 모두에 영향. */}
                  {effectiveSessionReuse === true && (
                    <div
                      role="alert"
                      className="px-4 py-3 bg-rose-50 dark:bg-rose-900/30 border-l-4 border-rose-500 dark:border-rose-400 rounded text-sm text-rose-900 dark:text-rose-100"
                    >
                      <div className="flex items-start gap-2">
                        <span aria-hidden className="text-base leading-none">🚨</span>
                        <div className="flex-1">
                          <div className="font-bold mb-1">{t('models.overrides.sessionReuseClientWarningTitle')}</div>
                          <p className="leading-relaxed">{t('models.overrides.sessionReuseClientWarningBody')}</p>
                          <p className="mt-2 text-xs">
                            <a
                              href="https://github.com/Starhunter-9/star-cliproxy/blob/main/docs/client-integration-session-reuse.md"
                              target="_blank"
                              rel="noreferrer"
                              className="underline font-semibold hover:text-rose-700 dark:hover:text-rose-50"
                            >
                              {t('models.overrides.sessionReuseClientWarningCta')}
                            </a>
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 세션 동작 그룹 — ephemeral/session_reuse/session_ttl_ms */}
                  <fieldset className="border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50/60 dark:bg-gray-800/40 px-4 py-3">
                    <legend className="px-2 text-xs font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-300">
                      {t('models.overrides.groupSession')}
                    </legend>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                      <div>
                        <label className="text-sm font-semibold text-gray-800 dark:text-gray-100 block mb-1.5">
                          {t('models.overrides.ephemeralLabel')}
                          <span className="ml-1.5 text-[11px] font-mono text-gray-500 dark:text-gray-400 font-normal">ephemeral</span>
                          {/* 실효값 배지 — 폼 명시 또는 yaml 기본 또는 강제 결과 */}
                          {effectiveEphemeral !== undefined && (
                            <span
                              className={`ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold ${
                                ephemeralIsForced
                                  ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border border-amber-300 dark:border-amber-700'
                                  : 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border border-blue-300 dark:border-blue-700'
                              }`}
                            >
                              {ephemeralIsForced ? t('models.overrides.autoLabel') : t('models.overrides.effectiveLabel')}: {String(effectiveEphemeral)}
                            </span>
                          )}
                        </label>
                        <select
                          value={form.override_ephemeral}
                          onChange={(e) => handleEphemeralChange(e.target.value as TriState)}
                          disabled={ephemeralIsForced}
                          className={`w-full bg-white dark:bg-gray-900 border border-gray-400 dark:border-gray-600 rounded px-3 py-2 text-sm text-gray-900 dark:text-gray-50 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none ${
                            ephemeralIsForced ? 'opacity-60 cursor-not-allowed' : ''
                          }`}
                        >
                          <option value="">{defaultLabel(effectiveEphemeralBase)}</option>
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                        {ephemeralIsForced ? (
                          <p
                            role="note"
                            className="mt-1.5 px-2 py-1.5 rounded border-l-4 border-amber-500 dark:border-amber-400 bg-amber-50 dark:bg-amber-900/20 text-xs text-amber-900 dark:text-amber-100 leading-relaxed"
                          >
                            ⚠️ {t('models.overrides.ephemeralForcedNote')}
                          </p>
                        ) : (
                          <p className="mt-1.5 text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
                            {t('models.overrides.ephemeralHelp')}
                          </p>
                        )}
                      </div>
                      <div>
                        <label className="text-sm font-semibold text-gray-800 dark:text-gray-100 block mb-1.5">
                          {t('models.overrides.sessionReuseLabel')}
                          <span className="ml-1.5 text-[11px] font-mono text-gray-500 dark:text-gray-400 font-normal">enable_session_reuse</span>
                          {effectiveSessionReuse !== undefined && (
                            <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border border-blue-300 dark:border-blue-700">
                              {t('models.overrides.effectiveLabel')}: {String(effectiveSessionReuse)}
                            </span>
                          )}
                        </label>
                        <select
                          value={form.override_enable_session_reuse}
                          onChange={(e) => handleSessionReuseChange(e.target.value as TriState)}
                          className="w-full bg-white dark:bg-gray-900 border border-gray-400 dark:border-gray-600 rounded px-3 py-2 text-sm text-gray-900 dark:text-gray-50 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
                        >
                          <option value="">{defaultLabel(effectiveSessionReuseBase)}</option>
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                        <p className="mt-1.5 text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
                          {t('models.overrides.sessionReuseHelp')}
                        </p>
                      </div>
                      <div className="md:col-span-2">
                        <label className="text-sm font-semibold text-gray-800 dark:text-gray-100 block mb-1.5">
                          {t('models.overrides.sessionTtlLabel')}
                          <span className="ml-1.5 text-[11px] font-mono text-gray-500 dark:text-gray-400 font-normal">session_ttl_ms</span>
                        </label>
                        <input
                          type="number"
                          placeholder={defaultLabel(effectiveSessionTtlBase)}
                          value={form.override_session_ttl_ms}
                          onChange={(e) => setForm({ ...form, override_session_ttl_ms: e.target.value })}
                          className="w-full bg-white dark:bg-gray-900 border border-gray-400 dark:border-gray-600 rounded px-3 py-2 text-sm text-gray-900 dark:text-gray-50 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
                        />
                        <p className="mt-1.5 text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
                          {t('models.overrides.sessionTtlHelp')}
                        </p>
                      </div>
                    </div>
                  </fieldset>

                  {/* 실행 설정 그룹 — timeout_ms / working_dir */}
                  <fieldset className="border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50/60 dark:bg-gray-800/40 px-4 py-3">
                    <legend className="px-2 text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                      {t('models.overrides.groupExecution')}
                    </legend>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                      <div>
                        <label className="text-sm font-semibold text-gray-800 dark:text-gray-100 block mb-1.5">
                          {t('models.overrides.timeoutLabel')}
                          <span className="ml-1.5 text-[11px] font-mono text-gray-500 dark:text-gray-400 font-normal">timeout_ms</span>
                        </label>
                        <input
                          type="number"
                          placeholder={defaultLabel(codexDefaults?.timeout_ms)}
                          value={form.override_timeout_ms}
                          onChange={(e) => setForm({ ...form, override_timeout_ms: e.target.value })}
                          className="w-full bg-white dark:bg-gray-900 border border-gray-400 dark:border-gray-600 rounded px-3 py-2 text-sm text-gray-900 dark:text-gray-50 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
                        />
                        <p className="mt-1.5 text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
                          {t('models.overrides.timeoutHelp')}
                        </p>
                      </div>
                      <div>
                        <label className="text-sm font-semibold text-gray-800 dark:text-gray-100 block mb-1.5">
                          {t('models.overrides.workingDirLabel')}
                          <span className="ml-1.5 text-[11px] font-mono text-gray-500 dark:text-gray-400 font-normal">working_dir</span>
                        </label>
                        <input
                          type="text"
                          placeholder={defaultLabel(codexDefaults?.working_dir)}
                          value={form.override_working_dir}
                          onChange={(e) => setForm({ ...form, override_working_dir: e.target.value })}
                          className="w-full bg-white dark:bg-gray-900 border border-gray-400 dark:border-gray-600 rounded px-3 py-2 text-sm text-gray-900 dark:text-gray-50 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
                        />
                        <p className="mt-1.5 text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
                          {t('models.overrides.workingDirHelp')}
                        </p>
                      </div>
                    </div>
                  </fieldset>

                  {/* 추가 인자 그룹 — extra_args */}
                  <fieldset className="border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50/60 dark:bg-gray-800/40 px-4 py-3">
                    <legend className="px-2 text-xs font-semibold uppercase tracking-wider text-purple-700 dark:text-purple-300">
                      {t('models.overrides.groupArgs')}
                    </legend>
                    <div className="mt-2">
                      <label className="text-sm font-semibold text-gray-800 dark:text-gray-100 block mb-1.5">
                        {t('models.overrides.extraArgsLabel')}
                        <span className="ml-1.5 text-[11px] font-mono text-gray-500 dark:text-gray-400 font-normal">extra_args</span>
                      </label>
                      <textarea
                        rows={3}
                        placeholder={
                          codexDefaults?.extra_args && codexDefaults.extra_args.length > 0
                            ? `${t('models.overrides.defaultPrefix')}:\n${codexDefaults.extra_args.join('\n')}`
                            : t('models.overrides.extraArgsPlaceholder')
                        }
                        value={form.override_extra_args}
                        onChange={(e) => setForm({ ...form, override_extra_args: e.target.value })}
                        className="w-full bg-white dark:bg-gray-900 border border-gray-400 dark:border-gray-600 rounded px-3 py-2 text-sm text-gray-900 dark:text-gray-50 placeholder:text-gray-400 dark:placeholder:text-gray-500 font-mono focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
                      />
                    </div>
                  </fieldset>
                </div>
              </details>
            )}

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
