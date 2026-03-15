import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchDashboard, type DashboardData } from '../api/client';

const statusDot: Record<string, string> = {
  healthy: 'bg-green-400',
  unhealthy: 'bg-red-400',
  unknown: 'bg-yellow-400',
};

const statusLabel: Record<string, string> = {
  healthy: 'Online',
  unhealthy: 'Offline',
  unknown: 'Unknown',
};

const reqStatusStyle: Record<string, string> = {
  success: 'text-green-400',
  error: 'text-red-400',
  timeout: 'text-yellow-400',
  cancelled: 'text-gray-400',
};

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const navigate = useNavigate();

  const load = () => {
    fetchDashboard()
      .then((d) => { setData(d); setLastUpdated(new Date()); setError(null); })
      .catch((e) => setError(e.message));
  };

  useEffect(() => {
    load();
    // 활성 요청이 있으면 5초, 없으면 30초 간격
    const getInterval = () => (data?.activeRequests?.count ?? 0) > 0 ? 5_000 : 30_000;
    let timer = setInterval(load, getInterval());

    const adjustInterval = () => {
      clearInterval(timer);
      timer = setInterval(load, getInterval());
    };

    // 데이터 변경 시 간격 조정
    const checkInterval = setInterval(adjustInterval, 10_000);

    return () => {
      clearInterval(timer);
      clearInterval(checkInterval);
    };
  }, [data?.activeRequests?.count]);

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-400 text-lg">Connection Failed</p>
        <p className="text-gray-500 mt-2">Backend server (port 8300) is running?</p>
        <button onClick={load} className="mt-4 px-4 py-2 bg-gray-800 rounded text-sm hover:bg-gray-700">Retry</button>
      </div>
    );
  }

  if (!data) {
    return <div className="text-gray-500 text-center py-20">Loading...</div>;
  }

  const { overview, today, apiKeys: keys, modelMappings: mappings, providers, cache, rateLimits, providerStats, popularModels, hourlyTrend, recentRequests, recentErrors, activeRequests } = data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Dashboard</h2>
          <p className="text-sm text-gray-500 mt-0.5">AI CLI Proxy Service</p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-gray-600">
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button onClick={load} className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-xs text-gray-400">
            Refresh
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4">
        <SummaryCard
          label="Total Requests"
          value={overview.totalRequests.toLocaleString()}
          sub={`Today: ${today.count}`}
          accent="blue"
        />
        <SummaryCard
          label="Success Rate"
          value={`${overview.successRate.toFixed(1)}%`}
          sub={`${overview.successCount} success / ${overview.errorCount + overview.timeoutCount} failed`}
          accent={overview.successRate >= 90 ? 'green' : overview.successRate >= 50 ? 'yellow' : 'red'}
        />
        <SummaryCard
          label="Avg Latency"
          value={`${overview.avgLatencyMs.toLocaleString()}ms`}
          sub={`Today: ${today.avgLatencyMs}ms`}
          accent="purple"
        />
        <SummaryCard
          label="Active API Keys"
          value={String(keys.active)}
          sub={`${mappings.active} model mappings`}
          accent="amber"
        />
      </div>

      {/* Active Requests */}
      {activeRequests.count > 0 && (
        <div className="bg-gray-900 border border-blue-500/30 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500" />
            </span>
            <h3 className="text-sm font-semibold text-blue-400">
              Processing {activeRequests.count} request{activeRequests.count > 1 ? 's' : ''}
            </h3>
          </div>
          <div className="space-y-1.5">
            {activeRequests.requests.map((req) => (
              <div key={req.requestId} className="flex items-center justify-between py-2 px-3 bg-blue-500/5 border border-blue-500/10 rounded-lg text-xs">
                <div className="flex items-center gap-3">
                  <span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                  <span className="text-gray-300 font-mono">{req.modelAlias}</span>
                  <span className="text-gray-500">{req.provider}</span>
                  <span className="text-gray-600 font-mono">{req.actualModel}</span>
                  {req.isStream && <span className="px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded text-xs">SSE</span>}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`font-mono ${req.elapsedMs > 30000 ? 'text-red-400' : req.elapsedMs > 10000 ? 'text-yellow-400' : 'text-blue-400'}`}>
                    {req.elapsedMs >= 1000 ? `${(req.elapsedMs / 1000).toFixed(1)}s` : `${req.elapsedMs}ms`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Middle Row: Hourly Trend + System Status */}
      <div className="grid grid-cols-5 gap-4">
        {/* Hourly Request Trend (24h) */}
        <div className="col-span-3 bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-400">Hourly Requests (24h)</h3>
            <div className="flex items-center gap-3 text-xs text-gray-600">
              <span className="flex items-center gap-1"><span className="w-2 h-2 bg-green-500/60 rounded-sm inline-block" /> success</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 bg-red-500/60 rounded-sm inline-block" /> failed</span>
            </div>
          </div>
          <HourlyChart data={hourlyTrend} />
        </div>

        {/* System Status */}
        <div className="col-span-2 bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-400 mb-4">System Status</h3>
          <div className="space-y-3">
            {/* Providers */}
            {providers.map((p) => (
              <div key={p.name} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${statusDot[p.status] ?? statusDot.unknown}`} />
                  <span className="text-sm text-gray-300 capitalize">{p.name}</span>
                </div>
                <span className={`text-xs ${p.status === 'healthy' ? 'text-green-400' : p.status === 'unhealthy' ? 'text-red-400' : 'text-yellow-400'}`}>
                  {statusLabel[p.status] ?? 'Unknown'}
                </span>
              </div>
            ))}

            <div className="border-t border-gray-800 my-2" />

            {/* Cache */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-400">Cache</span>
              <span className="text-xs text-gray-500">{cache.activeEntries} entries</span>
            </div>

            {/* Rate Limit */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-400">Rate Limit</span>
              <span className="text-xs text-gray-500">{rateLimits.global.rpm} RPM / {rateLimits.global.rpd} RPD</span>
            </div>

            {/* Total Tokens */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-400">Total Tokens</span>
              <span className="text-xs text-gray-500">{overview.totalTokens.toLocaleString()}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Row: Recent Requests + Popular Models */}
      <div className="grid grid-cols-2 gap-4">
        {/* Recent Requests */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-400">Recent Requests</h3>
            <button
              onClick={() => navigate('/logs')}
              className="text-xs text-gray-500 hover:text-blue-400 transition-colors"
            >
              View All
            </button>
          </div>
          {recentRequests.length === 0 ? (
            <div className="h-32 flex items-center justify-center text-gray-600 text-sm">
              No requests yet
            </div>
          ) : (
            <div className="space-y-1">
              {recentRequests.map((req) => (
                <div key={req.id} className={`py-1.5 px-3 rounded text-xs ${req.status !== 'success' ? 'bg-red-500/5 border border-red-500/20' : 'bg-gray-800/30'}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-600 font-mono w-14">
                        {formatTime(req.createdAt)}
                      </span>
                      <span className="text-gray-300 font-mono">{req.modelAlias}</span>
                      <span className="text-gray-600">{req.provider}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={reqStatusStyle[req.status] ?? 'text-gray-400'}>
                        {req.status}
                      </span>
                      <span className="text-gray-600 w-16 text-right">{req.latencyMs?.toLocaleString()}ms</span>
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

        {/* Provider Usage + Popular Models */}
        <div className="space-y-4">
          {/* Provider Usage */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-gray-400 mb-3">Provider Usage</h3>
            {providerStats.length === 0 ? (
              <div className="h-16 flex items-center justify-center text-gray-600 text-sm">
                No data yet
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                {providerStats.map((p) => (
                  <div key={p.provider} className="bg-gray-800/50 rounded-lg p-3 text-center">
                    <div className="text-xs text-gray-500 capitalize mb-1">{p.provider}</div>
                    <div className="text-xl font-bold">{p.count}</div>
                    <div className="text-xs text-gray-600">{Math.round(p.avgLatencyMs)}ms avg</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Popular Models */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-gray-400 mb-3">Popular Models</h3>
            {popularModels.length === 0 ? (
              <div className="h-16 flex items-center justify-center text-gray-600 text-sm">
                No data yet
              </div>
            ) : (
              <div className="space-y-2">
                {popularModels.map((m, i) => {
                  const maxCount = Math.max(...popularModels.map((mm) => mm.count), 1);
                  return (
                    <div key={`${m.modelAlias}-${m.provider}`} className="flex items-center gap-3 text-sm">
                      <span className="text-gray-600 w-4 text-right">{i + 1}</span>
                      <span className="text-gray-300 font-mono flex-1">{m.modelAlias}</span>
                      <div className="w-24 h-2 bg-gray-800 rounded overflow-hidden">
                        <div className="h-full bg-blue-500/50 rounded" style={{ width: `${(m.count / maxCount) * 100}%` }} />
                      </div>
                      <span className="text-gray-500 text-xs w-8 text-right">{m.count}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recent Errors */}
      {recentErrors.length > 0 && (
        <div className="bg-gray-900 border border-red-500/20 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-red-400 mb-3">Recent Errors</h3>
          <div className="space-y-2">
            {recentErrors.map((err) => (
              <div key={err.id} className="bg-red-500/5 border border-red-500/10 rounded-lg px-4 py-2.5">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-600 font-mono">{formatTime(err.createdAt)}</span>
                    <span className="text-gray-300 font-mono">{err.modelAlias}</span>
                    <span className="text-gray-600">{err.provider}</span>
                    <span className={`px-1.5 py-0.5 rounded ${err.status === 'timeout' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-red-500/20 text-red-400'}`}>
                      {err.status}
                    </span>
                  </div>
                  <span className="text-gray-600">{err.latencyMs?.toLocaleString()}ms</span>
                </div>
                {err.errorMessage && (
                  <p className="text-xs text-red-300/70 mt-1.5 break-all">{err.errorMessage}</p>
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
    blue: 'border-blue-500/30',
    green: 'border-green-500/30',
    yellow: 'border-yellow-500/30',
    red: 'border-red-500/30',
    purple: 'border-purple-500/30',
    amber: 'border-amber-500/30',
  };

  const valueColors: Record<string, string> = {
    blue: 'text-blue-400',
    green: 'text-green-400',
    yellow: 'text-yellow-400',
    red: 'text-red-400',
    purple: 'text-purple-400',
    amber: 'text-amber-400',
  };

  return (
    <div className={`bg-gray-900 border ${accentColors[accent]} rounded-xl p-4`}>
      <div className="text-xs text-gray-500 uppercase tracking-wider">{label}</div>
      <div className={`text-2xl font-bold mt-2 ${valueColors[accent]}`}>{value}</div>
      <div className="text-xs text-gray-600 mt-1">{sub}</div>
    </div>
  );
}

// UTC 문자열 → 로컬 시간 표시 (Invalid Date 방지)
function formatTime(dateStr: string): string {
  if (!dateStr || dateStr.includes('datetime')) return '--:--';
  // SQLite의 "YYYY-MM-DD HH:MM:SS" 형식에 T와 Z 추가
  const normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// 24시간 시간대별 바 차트
function HourlyChart({ data }: { data: Array<{ hour: number; count: number; successCount: number; errorCount: number }> }) {
  const BAR_MAX_HEIGHT = 120; // px

  // 0~23시 전체 슬롯 생성
  const slots = Array.from({ length: 24 }, (_, i) => {
    const match = data.find((d) => d.hour === i);
    return {
      hour: i,
      count: match?.count ?? 0,
      successCount: match?.successCount ?? 0,
      errorCount: match?.errorCount ?? 0,
    };
  });

  const maxCount = Math.max(...slots.map((s) => s.count), 1);
  const hasData = slots.some((s) => s.count > 0);
  const totalRequests = slots.reduce((sum, s) => sum + s.count, 0);

  if (!hasData) {
    return (
      <div className="h-36 flex items-center justify-center text-gray-600 text-sm">
        No requests in the last 24 hours
      </div>
    );
  }

  return (
    <div>
      <div className="text-xs text-gray-600 mb-2 text-right">Total: {totalRequests} requests</div>
      {/* Bars */}
      <div className="flex items-end gap-1" style={{ height: `${BAR_MAX_HEIGHT}px` }}>
        {slots.map((slot) => {
          const totalPx = Math.round((slot.count / maxCount) * BAR_MAX_HEIGHT);
          const successPx = Math.round((slot.successCount / Math.max(slot.count, 1)) * totalPx);
          const errorPx = totalPx - successPx;

          return (
            <div
              key={slot.hour}
              className="flex-1 flex flex-col justify-end relative group cursor-default"
            >
              {slot.count > 0 ? (
                <>
                  <div
                    className="w-full bg-blue-500/60 rounded-t-sm"
                    style={{ height: `${successPx}px` }}
                  />
                  {errorPx > 0 && (
                    <div
                      className="w-full bg-red-500/60 rounded-b-sm"
                      style={{ height: `${errorPx}px` }}
                    />
                  )}
                </>
              ) : (
                <div className="w-full bg-gray-800/30 rounded-sm" style={{ height: '2px' }} />
              )}
              {/* Tooltip */}
              <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-gray-800 border border-gray-700 text-gray-300 text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10">
                <div>{slot.hour}:00</div>
                <div>{slot.count} req ({slot.errorCount > 0 ? `${slot.errorCount} err` : 'all ok'})</div>
              </div>
            </div>
          );
        })}
      </div>
      {/* Hour labels */}
      <div className="flex gap-1 mt-1.5 border-t border-gray-800 pt-1">
        {slots.map((slot) => (
          <div key={slot.hour} className="flex-1 text-center text-xs text-gray-600">
            {slot.hour % 3 === 0 ? `${String(slot.hour).padStart(2, '0')}` : ''}
          </div>
        ))}
      </div>
    </div>
  );
}
