import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '../i18n/context';
import { fetchDashboard, fetchTrend, type DashboardData, type TrendData } from '../api/client';

const statusDot: Record<string, string> = {
  healthy: 'bg-green-400',
  unhealthy: 'bg-red-400',
  unknown: 'bg-yellow-400',
};

const reqStatusStyle: Record<string, string> = {
  success: 'text-green-400',
  error: 'text-red-400',
  timeout: 'text-yellow-400',
  cancelled: 'text-gray-400',
};

const PERIOD_OPTIONS = [
  { label: '1d', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All', days: 0 },
];

export default function DashboardPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [days, setDays] = useState(0); // 0 = 전체
  const navigate = useNavigate();

  const load = () => {
    fetchDashboard(days || undefined)
      .then((d) => { setData(d); setLastUpdated(new Date()); setError(null); })
      .catch((e) => setError(e.message));
  };

  // 초기 로드 + 기간 변경 시 재로드
  useEffect(() => { load(); }, [days]);

  // 자동 리프레시: 활성 요청 유무에 따라 간격 조정 (기본 10초, 활성 요청 시 2초)
  const hasActiveRequests = (data?.activeRequests?.count ?? 0) > 0;
  useEffect(() => {
    const intervalMs = hasActiveRequests ? 2_000 : 10_000;
    const timer = setInterval(load, intervalMs);
    return () => clearInterval(timer);
  }, [hasActiveRequests]);

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-400 text-lg">{t('dashboard.connectionFailed')}</p>
        <p className="text-gray-400 dark:text-gray-500 mt-2">{t('dashboard.backendRunning')}</p>
        <button onClick={load} className="mt-4 px-4 py-2 bg-gray-200 dark:bg-gray-800 rounded text-sm hover:bg-gray-300 dark:hover:bg-gray-700">{t('common.retry')}</button>
      </div>
    );
  }

  if (!data) {
    return <div className="text-gray-400 dark:text-gray-500 text-center py-20">{t('common.loading')}</div>;
  }

  const { overview, today, apiKeys: keys, modelMappings: mappings, providers, cache, rateLimits, providerStats, popularModels, recentRequests, recentErrors, activeRequests } = data;

  const statusLabel = (status: string) => {
    if (status === 'healthy') return t('common.online');
    if (status === 'unhealthy') return t('common.offline');
    return t('common.unknown');
  };

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('dashboard.title')}</h2>
          <p className="text-sm text-gray-400 dark:text-gray-500 mt-0.5">{t('dashboard.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          {/* 기간 선택 */}
          <div className="flex items-center gap-1">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                onClick={() => setDays(opt.days)}
                className={`px-2 py-0.5 rounded text-xs transition-colors ${
                  days === opt.days
                    ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400'
                    : 'text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {lastUpdated && (
            <span className="text-xs text-gray-500 dark:text-gray-600">
              {t('dashboard.updated')} {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button onClick={load} className="px-3 py-1.5 bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 rounded text-xs text-gray-500 dark:text-gray-400">
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {/* 요약 카드 */}
      <div className="grid grid-cols-4 gap-4">
        <SummaryCard
          label={t('dashboard.totalRequests')}
          value={overview.totalRequests.toLocaleString()}
          sub={`${t('dashboard.today')}: ${today.count}`}
          accent="blue"
        />
        <SummaryCard
          label={t('dashboard.successRate')}
          value={`${overview.successRate.toFixed(1)}%`}
          sub={`${overview.successCount} ${t('dashboard.success')} / ${overview.errorCount + overview.timeoutCount} ${t('dashboard.failed')}`}
          accent={overview.successRate >= 90 ? 'green' : overview.successRate >= 50 ? 'yellow' : 'red'}
        />
        <SummaryCard
          label={t('dashboard.avgLatency')}
          value={`${overview.avgLatencyMs.toLocaleString()}ms`}
          sub={`${t('dashboard.today')}: ${today.avgLatencyMs}ms`}
          accent="purple"
        />
        <SummaryCard
          label={t('dashboard.activeApiKeys')}
          value={String(keys.active)}
          sub={`${mappings.active} ${t('dashboard.modelMappings')}`}
          accent="amber"
        />
      </div>

      {/* 활성 요청 */}
      {activeRequests.count > 0 && (
        <div className="bg-white dark:bg-gray-900 border border-blue-200 dark:border-blue-500/30 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500" />
            </span>
            <h3 className="text-sm font-semibold text-blue-600 dark:text-blue-400">
              {t(activeRequests.count > 1 ? 'dashboard.processingRequestsPlural' : 'dashboard.processingRequests', { count: activeRequests.count })}
            </h3>
          </div>
          <div className="space-y-1.5">
            {activeRequests.requests.map((req) => (
              <div key={req.requestId} className="flex items-center justify-between py-2 px-3 bg-blue-50 dark:bg-blue-500/5 border border-blue-100 dark:border-blue-500/10 rounded-lg text-xs">
                <div className="flex items-center gap-3">
                  <span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                  <span className="text-gray-700 dark:text-gray-300 font-mono">{req.modelAlias}</span>
                  <span className="text-gray-400 dark:text-gray-500">{req.provider}</span>
                  <span className="text-gray-500 dark:text-gray-600 font-mono">{req.actualModel}</span>
                  {req.isStream && <span className="px-1.5 py-0.5 bg-purple-100 dark:bg-purple-500/20 text-purple-600 dark:text-purple-400 rounded text-xs">SSE</span>}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`font-mono ${req.elapsedMs > 30000 ? 'text-red-400' : req.elapsedMs > 10000 ? 'text-yellow-400' : 'text-blue-500 dark:text-blue-400'}`}>
                    {req.elapsedMs >= 1000 ? `${(req.elapsedMs / 1000).toFixed(1)}s` : `${req.elapsedMs}ms`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 중간 행: 트렌드 차트 + 시스템 상태 */}
      <div className="grid grid-cols-5 gap-4">
        {/* 요청 트렌드 */}
        <div className="col-span-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
          <TrendChart />
        </div>

        {/* 시스템 상태 */}
        <div className="col-span-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-4">{t('dashboard.systemStatus')}</h3>
          <div className="space-y-3">
            {/* 프로바이더 */}
            {providers.map((p) => (
              <div key={p.name} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${statusDot[p.status] ?? statusDot.unknown}`} />
                  <span className="text-sm text-gray-700 dark:text-gray-300 capitalize">{p.name}</span>
                </div>
                <span className={`text-xs ${p.status === 'healthy' ? 'text-green-500 dark:text-green-400' : p.status === 'unhealthy' ? 'text-red-500 dark:text-red-400' : 'text-yellow-500 dark:text-yellow-400'}`}>
                  {statusLabel(p.status)}
                </span>
              </div>
            ))}

            <div className="border-t border-gray-200 dark:border-gray-800 my-2" />

            {/* 캐시 */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">{t('dashboard.cache')}</span>
              <span className="text-xs text-gray-400 dark:text-gray-500">{cache.activeEntries} {t('dashboard.entries')}</span>
            </div>

            {/* 레이트 리밋 */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">{t('dashboard.rateLimit')}</span>
              <span className="text-xs text-gray-400 dark:text-gray-500">{rateLimits.global.rpm} RPM / {rateLimits.global.rpd} RPD</span>
            </div>

            {/* 총 토큰 */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">{t('dashboard.totalTokens')}</span>
              <span className="text-xs text-gray-400 dark:text-gray-500">{overview.totalTokens.toLocaleString()}</span>
            </div>
          </div>
        </div>
      </div>

      {/* 하단 행: 최근 요청 + 인기 모델 */}
      <div className="grid grid-cols-2 gap-4">
        {/* 최근 요청 */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400">{t('dashboard.recentRequests')}</h3>
            <button
              onClick={() => navigate('/logs')}
              className="text-xs text-gray-400 dark:text-gray-500 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
            >
              {t('common.viewAll')}
            </button>
          </div>
          {recentRequests.length === 0 && activeRequests.count === 0 ? (
            <div className="h-32 flex items-center justify-center text-gray-400 dark:text-gray-600 text-sm">
              {t('dashboard.noRequests')}
            </div>
          ) : (
            <div className="space-y-1">
              {/* 진행 중인 요청 */}
              {activeRequests.requests.map((req) => (
                <div key={req.requestId} className="py-1.5 px-3 rounded text-xs bg-blue-50 dark:bg-blue-500/5 border border-blue-100 dark:border-blue-500/20">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                      <span className="text-blue-600 dark:text-blue-300 font-mono">{req.modelAlias}</span>
                      <span className="text-gray-500 dark:text-gray-600">{req.provider}</span>
                      {req.isStream && <span className="px-1 py-0.5 bg-purple-100 dark:bg-purple-500/20 text-purple-600 dark:text-purple-400 rounded text-[10px]">SSE</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-blue-500 dark:text-blue-400 animate-pulse">{t('common.processing')}</span>
                      <span className={`text-gray-500 dark:text-gray-600 w-16 text-right font-mono ${req.elapsedMs > 30000 ? 'text-red-400' : ''}`}>
                        {req.elapsedMs >= 1000 ? `${(req.elapsedMs / 1000).toFixed(1)}s` : `${req.elapsedMs}ms`}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
              {/* 완료된 요청 */}
              {recentRequests.map((req) => (
                <div key={req.id} className={`py-1.5 px-3 rounded text-xs ${req.status !== 'success' ? 'bg-red-50 dark:bg-red-500/5 border border-red-200 dark:border-red-500/20' : 'bg-gray-50 dark:bg-gray-800/30'}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500 dark:text-gray-600 font-mono w-14">
                        {formatTime(req.createdAt)}
                      </span>
                      <span className="text-gray-700 dark:text-gray-300 font-mono">{req.modelAlias}</span>
                      <span className="text-gray-500 dark:text-gray-600">{req.provider}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={reqStatusStyle[req.status] ?? 'text-gray-400'}>
                        {req.status}
                      </span>
                      <span className="text-gray-500 dark:text-gray-600 w-16 text-right">{req.latencyMs?.toLocaleString()}ms</span>
                    </div>
                  </div>
                  {req.status !== 'success' && req.errorMessage && (
                    <div className="mt-1 text-red-400/80 text-xs truncate pl-16" title={req.errorMessage}>
                      {req.errorMessage}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 프로바이더 사용량 + 인기 모델 */}
        <div className="space-y-4">
          {/* 프로바이더 사용량 */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-3">{t('dashboard.providerUsage')}</h3>
            {providerStats.length === 0 ? (
              <div className="h-16 flex items-center justify-center text-gray-400 dark:text-gray-600 text-sm">
                {t('common.noDataYet')}
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                {providerStats.map((p) => (
                  <div key={p.provider} className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3 text-center">
                    <div className="text-xs text-gray-400 dark:text-gray-500 capitalize mb-1">{p.provider}</div>
                    <div className="text-xl font-bold text-gray-800 dark:text-gray-100">{p.count}</div>
                    <div className="text-xs text-gray-400 dark:text-gray-600">{Math.round(p.avgLatencyMs)}ms {t('dashboard.avg')}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 인기 모델 */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-3">{t('dashboard.popularModels')}</h3>
            {popularModels.length === 0 ? (
              <div className="h-16 flex items-center justify-center text-gray-400 dark:text-gray-600 text-sm">
                {t('common.noDataYet')}
              </div>
            ) : (
              <div className="space-y-2">
                {popularModels.map((m, i) => {
                  const maxCount = Math.max(...popularModels.map((mm) => mm.count), 1);
                  return (
                    <div key={`${m.modelAlias}-${m.provider}`} className="flex items-center gap-3 text-sm">
                      <span className="text-gray-400 dark:text-gray-600 w-4 text-right">{i + 1}</span>
                      <span className="text-gray-700 dark:text-gray-300 font-mono flex-1">{m.modelAlias}</span>
                      <div className="w-24 h-2 bg-gray-200 dark:bg-gray-800 rounded overflow-hidden">
                        <div className="h-full bg-blue-500/50 rounded" style={{ width: `${(m.count / maxCount) * 100}%` }} />
                      </div>
                      <span className="text-gray-400 dark:text-gray-500 text-xs w-8 text-right">{m.count}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 최근 에러 */}
      {recentErrors.length > 0 && (
        <div className="bg-white dark:bg-gray-900 border border-red-200 dark:border-red-500/20 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-red-500 dark:text-red-400 mb-3">{t('dashboard.recentErrors')}</h3>
          <div className="space-y-2">
            {recentErrors.map((err) => (
              <div key={err.id} className="bg-red-50 dark:bg-red-500/5 border border-red-100 dark:border-red-500/10 rounded-lg px-4 py-2.5">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 dark:text-gray-600 font-mono">{formatTime(err.createdAt)}</span>
                    <span className="text-gray-700 dark:text-gray-300 font-mono">{err.modelAlias}</span>
                    <span className="text-gray-500 dark:text-gray-600">{err.provider}</span>
                    <span className={`px-1.5 py-0.5 rounded ${err.status === 'timeout' ? 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-600 dark:text-yellow-400' : 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'}`}>
                      {err.status}
                    </span>
                  </div>
                  <span className="text-gray-500 dark:text-gray-600">{err.latencyMs?.toLocaleString()}ms</span>
                </div>
                {err.errorMessage && (
                  <p className="text-xs text-red-400 dark:text-red-300/70 mt-1.5 break-all">{err.errorMessage}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent: 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'amber';
}) {
  const accentColors: Record<string, string> = {
    blue: 'border-blue-200 dark:border-blue-500/30',
    green: 'border-green-200 dark:border-green-500/30',
    yellow: 'border-yellow-200 dark:border-yellow-500/30',
    red: 'border-red-200 dark:border-red-500/30',
    purple: 'border-purple-200 dark:border-purple-500/30',
    amber: 'border-amber-200 dark:border-amber-500/30',
  };

  const valueColors: Record<string, string> = {
    blue: 'text-blue-600 dark:text-blue-400',
    green: 'text-green-600 dark:text-green-400',
    yellow: 'text-yellow-600 dark:text-yellow-400',
    red: 'text-red-600 dark:text-red-400',
    purple: 'text-purple-600 dark:text-purple-400',
    amber: 'text-amber-600 dark:text-amber-400',
  };

  return (
    <div className={`bg-white dark:bg-gray-900 border ${accentColors[accent]} rounded-xl p-4`}>
      <div className="text-xs text-gray-400 dark:text-gray-500 uppercase tracking-wider">{label}</div>
      <div className={`text-2xl font-bold mt-2 ${valueColors[accent]}`}>{value}</div>
      <div className="text-xs text-gray-400 dark:text-gray-600 mt-1">{sub}</div>
    </div>
  );
}

// UTC 문자열 -> 로컬 시간 표시 (Invalid Date 방지)
function formatTime(dateStr: string): string {
  if (!dateStr || dateStr.includes('datetime')) return '--:--';
  // SQLite의 "YYYY-MM-DD HH:MM:SS" 형식에 T와 Z 추가
  const normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// 모델별 색상 팔레트
const MODEL_COLORS = [
  'bg-blue-500/70', 'bg-emerald-500/70', 'bg-purple-500/70', 'bg-amber-500/70',
  'bg-pink-500/70', 'bg-cyan-500/70', 'bg-orange-500/70', 'bg-indigo-500/70',
];
const MODEL_DOT_COLORS = [
  'bg-blue-400', 'bg-emerald-400', 'bg-purple-400', 'bg-amber-400',
  'bg-pink-400', 'bg-cyan-400', 'bg-orange-400', 'bg-indigo-400',
];

const RANGE_OPTIONS = [
  { label: '6h', hours: 6 },
  { label: '12h', hours: 12 },
  { label: '24h', hours: 24 },
  { label: '3d', hours: 72 },
  { label: '7d', hours: 168 },
];

// 독립 Trend 차트 컴포넌트 (자체 데이터 fetch + 필터 상태)
function TrendChart() {
  const { t } = useTranslation();
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<TrendData | null>(null);
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    fetchTrend(hours).then(setData).catch(() => {});
  }, [hours]);

  useEffect(() => { load(); }, [load]);
  // 자동 리프레시 30초
  useEffect(() => {
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (!data) return <div className="h-40 flex items-center justify-center text-gray-400 dark:text-gray-600 text-sm">{t('common.loading')}</div>;

  // 모델 목록 (요청 수 내림차순)
  const modelCounts = new Map<string, number>();
  data.byModel.forEach((d) => modelCounts.set(d.modelAlias, (modelCounts.get(d.modelAlias) ?? 0) + d.count));
  const allModels = [...modelCounts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const colorMap = new Map(allModels.map((m, i) => [m, i % MODEL_COLORS.length]));
  const visibleModels = allModels.filter((m) => !hiddenModels.has(m));

  // 시간 슬롯 생성 (현재 시각 기준 역산)
  const now = new Date();
  const slots = Array.from({ length: hours }, (_, i) => {
    const d = new Date(now.getTime() - (hours - 1 - i) * 3600_000);
    const slotKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}`;

    const match = data.trend.find((item) => item.slot === slotKey);
    const modelBreakdown = visibleModels.map((model) => {
      const entry = data.byModel.find((b) => b.slot === slotKey && b.modelAlias === model);
      return { model, count: entry?.count ?? 0 };
    }).filter((m) => m.count > 0);

    const visibleCount = modelBreakdown.reduce((sum, m) => sum + m.count, 0);

    return {
      key: slotKey,
      localHour: d.getHours(),
      localDate: d,
      totalCount: match?.count ?? 0,
      visibleCount,
      errorCount: match?.errorCount ?? 0,
      models: modelBreakdown,
    };
  });

  const maxCount = Math.max(...slots.map((s) => s.visibleCount), 1);
  const totalVisible = slots.reduce((sum, s) => sum + s.visibleCount, 0);
  const BAR_MAX_HEIGHT = 120;

  // 시간 라벨 간격 (기간에 따라 적응적)
  const labelInterval = hours <= 12 ? 1 : hours <= 24 ? 2 : hours <= 72 ? 6 : 12;
  // 날짜 경계 표시 여부
  const showDateLabels = hours > 24;

  const toggleModel = (model: string) => {
    setHiddenModels((prev) => {
      const next = new Set(prev);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });
  };

  const showAll = () => setHiddenModels(new Set());
  const allVisible = hiddenModels.size === 0;

  return (
    <div>
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400">{t('dashboard.requestTrend')}</h3>
        <div className="flex items-center gap-1">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.hours}
              onClick={() => setHours(opt.hours)}
              className={`px-2 py-0.5 rounded text-xs transition-colors ${
                hours === opt.hours
                  ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400'
                  : 'text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* 통계 */}
      <div className="text-xs text-gray-400 dark:text-gray-600 mb-2 text-right">
        {totalVisible} {t('common.requests')}
        {hiddenModels.size > 0 && <span className="text-gray-300 dark:text-gray-700"> {t('common.filtered')}</span>}
      </div>

      {/* 바 차트 */}
      <div className="flex items-end gap-px" style={{ height: `${BAR_MAX_HEIGHT}px` }}>
        {slots.map((slot, idx) => {
          const totalPx = Math.round((slot.visibleCount / maxCount) * BAR_MAX_HEIGHT);
          return (
            <div key={idx} className="flex-1 flex flex-col justify-end relative group cursor-default min-w-0">
              {slot.visibleCount > 0 ? (
                <div className="w-full flex flex-col justify-end" style={{ height: `${totalPx}px` }}>
                  {slot.models.map((m, mi) => {
                    const segPx = Math.max(Math.round((m.count / slot.visibleCount) * totalPx), 1);
                    const ci = colorMap.get(m.model) ?? 0;
                    return (
                      <div
                        key={m.model}
                        className={`w-full ${MODEL_COLORS[ci]} ${mi === 0 ? 'rounded-t-sm' : ''} ${mi === slot.models.length - 1 ? 'rounded-b-sm' : ''}`}
                        style={{ height: `${segPx}px` }}
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="w-full bg-gray-200 dark:bg-gray-800/20 rounded-sm" style={{ height: '1px' }} />
              )}
              {/* 툴팁 */}
              <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10">
                <div className="font-semibold">
                  {showDateLabels
                    ? `${slot.localDate.getMonth() + 1}/${slot.localDate.getDate()} ${String(slot.localHour).padStart(2, '0')}:00`
                    : `${String(slot.localHour).padStart(2, '0')}:00`
                  }
                  {' — '}{slot.visibleCount} req
                </div>
                {slot.models.map((m) => (
                  <div key={m.model} className="flex items-center gap-1">
                    <span className={`w-1.5 h-1.5 rounded-full ${MODEL_DOT_COLORS[colorMap.get(m.model) ?? 0]}`} />
                    <span>{m.model}: {m.count}</span>
                  </div>
                ))}
                {slot.errorCount > 0 && <div className="text-red-400">{slot.errorCount} {t('common.errors')}</div>}
              </div>
            </div>
          );
        })}
      </div>

      {/* 시간 라벨 */}
      <div className="flex gap-px mt-1 border-t border-gray-200 dark:border-gray-800 pt-1">
        {slots.map((slot, idx) => {
          const showLabel = idx % labelInterval === 0;
          const isNewDay = idx > 0 && slot.localDate.getDate() !== slots[idx - 1].localDate.getDate();
          return (
            <div key={idx} className="flex-1 text-center min-w-0 overflow-hidden">
              {isNewDay && showDateLabels ? (
                <span className="text-[9px] text-gray-400 dark:text-gray-500">
                  {slot.localDate.getMonth() + 1}/{slot.localDate.getDate()}
                </span>
              ) : showLabel ? (
                <span className="text-[10px] text-gray-400 dark:text-gray-600">
                  {String(slot.localHour).padStart(2, '0')}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* 모델 필터 레전드 */}
      {allModels.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mt-3 pt-2 border-t border-gray-200 dark:border-gray-800/50">
          {allModels.length > 1 && (
            <button
              onClick={showAll}
              className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                allVisible ? 'text-gray-400 dark:text-gray-600' : 'text-blue-500 dark:text-blue-400 hover:text-blue-400 dark:hover:text-blue-300'
              }`}
            >
              {t('common.all')}
            </button>
          )}
          {allModels.map((model) => {
            const ci = colorMap.get(model) ?? 0;
            const visible = !hiddenModels.has(model);
            return (
              <button
                key={model}
                onClick={() => toggleModel(model)}
                className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                  visible
                    ? 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                    : 'text-gray-300 dark:text-gray-700 line-through hover:text-gray-400 dark:hover:text-gray-500'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${visible ? MODEL_DOT_COLORS[ci] : 'bg-gray-300 dark:bg-gray-700'}`} />
                {model}
                <span className="text-gray-400 dark:text-gray-600">{modelCounts.get(model)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
