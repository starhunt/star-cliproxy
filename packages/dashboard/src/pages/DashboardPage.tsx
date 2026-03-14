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
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, []);

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

  const { overview, today, apiKeys: keys, modelMappings: mappings, providers, cache, rateLimits, providerStats, popularModels, dailyTrend, recentRequests } = data;

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

      {/* Middle Row: Daily Trend + System Status */}
      <div className="grid grid-cols-5 gap-4">
        {/* Daily Trend */}
        <div className="col-span-3 bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-400 mb-4">Daily Request Trend</h3>
          {dailyTrend.length === 0 ? (
            <div className="h-40 flex items-center justify-center text-gray-600 text-sm">
              No request data yet
            </div>
          ) : (
            <div className="space-y-1">
              {dailyTrend.map((day) => {
                const maxCount = Math.max(...dailyTrend.map((d) => d.count), 1);
                const barWidth = (day.count / maxCount) * 100;
                const successWidth = (day.successCount / Math.max(day.count, 1)) * barWidth;
                return (
                  <div key={day.date} className="flex items-center gap-3 text-xs">
                    <span className="w-20 text-gray-500 font-mono">{day.date.slice(5)}</span>
                    <div className="flex-1 h-5 bg-gray-800 rounded overflow-hidden relative">
                      <div
                        className="h-full bg-green-500/40 absolute left-0 top-0"
                        style={{ width: `${successWidth}%` }}
                      />
                      <div
                        className="h-full bg-red-500/40 absolute top-0"
                        style={{ left: `${successWidth}%`, width: `${barWidth - successWidth}%` }}
                      />
                    </div>
                    <span className="w-10 text-right text-gray-400">{day.count}</span>
                  </div>
                );
              })}
            </div>
          )}
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
            <div className="space-y-1.5">
              {recentRequests.map((req) => (
                <div key={req.id} className="flex items-center justify-between py-1.5 px-3 bg-gray-800/30 rounded text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-600 font-mono w-14">
                      {new Date(req.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
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
