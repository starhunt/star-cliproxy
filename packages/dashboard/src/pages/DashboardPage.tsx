import { useEffect, useState } from 'react';
import { fetchStats, fetchProviders, fetchLogs, type ProviderInfo } from '../api/client';

interface Stats {
  overview: {
    totalRequests: number;
    successRate: string;
    avgLatencyMs: number;
    totalTokens: number;
  };
  byProvider: Array<{ provider: string; count: number; successCount: number; avgLatencyMs: number }>;
  byModel: Array<{ modelAlias: string; provider: string; count: number }>;
}

interface LogItem {
  id: string;
  modelAlias: string;
  provider: string;
  status: string;
  latencyMs: number;
  createdAt: string;
}

const statusColor: Record<string, string> = {
  healthy: 'text-green-400',
  unhealthy: 'text-red-400',
  unknown: 'text-gray-500',
};

const statusDot: Record<string, string> = {
  healthy: 'bg-green-400',
  unhealthy: 'bg-red-400',
  unknown: 'bg-gray-500',
};

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [recentLogs, setRecentLogs] = useState<LogItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.allSettled([
      fetchStats().then(setStats),
      fetchProviders().then(setProviders),
      fetchLogs({ limit: 10 }).then((r) => setRecentLogs(r.data as LogItem[])),
    ]).catch(() => setError('Failed to load dashboard data'));
  }, []);

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-400 text-lg">{error}</p>
        <p className="text-gray-500 mt-2">Backend server (port 8300) is running?</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Dashboard</h2>

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Total Requests" value={stats?.overview.totalRequests ?? 0} />
        <StatCard label="Success Rate" value={`${stats?.overview.successRate ?? '0.0'}%`} />
        <StatCard label="Avg Latency" value={`${stats?.overview.avgLatencyMs ?? 0}ms`} />
        <StatCard label="Total Tokens" value={stats?.overview.totalTokens ?? 0} />
      </div>

      {/* Provider Health */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <h3 className="text-sm font-semibold text-gray-400 mb-3">Provider Health</h3>
        <div className="space-y-2">
          {providers.length === 0 && (
            <p className="text-gray-600 text-sm">No providers configured</p>
          )}
          {providers.map((p) => (
            <div key={p.name} className="flex items-center justify-between py-2 px-3 bg-gray-800/50 rounded-lg">
              <div className="flex items-center gap-3">
                <span className={`w-2 h-2 rounded-full ${statusDot[p.status] ?? statusDot.unknown}`} />
                <span className="font-medium capitalize">{p.name}</span>
                <span className={`text-xs ${statusColor[p.status] ?? statusColor.unknown}`}>
                  {p.status}
                </span>
              </div>
              <div className="text-xs text-gray-500">
                {p.queue ? `Queue: ${p.queue.pending}/${p.queue.concurrency}` : ''}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Provider Usage */}
      {stats?.byProvider && stats.byProvider.length > 0 && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h3 className="text-sm font-semibold text-gray-400 mb-3">Provider Usage</h3>
          <div className="grid grid-cols-3 gap-3">
            {stats.byProvider.map((p) => (
              <div key={p.provider} className="bg-gray-800/50 rounded-lg p-3">
                <div className="text-sm font-medium capitalize">{p.provider}</div>
                <div className="text-2xl font-bold mt-1">{p.count}</div>
                <div className="text-xs text-gray-500">
                  avg {Math.round(p.avgLatencyMs)}ms
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Requests */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <h3 className="text-sm font-semibold text-gray-400 mb-3">Recent Requests</h3>
        <div className="space-y-1">
          {recentLogs.length === 0 && (
            <p className="text-gray-600 text-sm">No requests yet</p>
          )}
          {recentLogs.map((log) => (
            <div key={log.id} className="flex items-center justify-between py-1.5 px-3 text-sm bg-gray-800/30 rounded">
              <div className="flex items-center gap-3">
                <span className="text-gray-500 font-mono text-xs">
                  {new Date(log.createdAt).toLocaleTimeString()}
                </span>
                <span className="text-gray-300">{log.modelAlias}</span>
                <span className="text-gray-600">-&gt;</span>
                <span className="text-gray-400">{log.provider}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className={log.status === 'success' ? 'text-green-400' : 'text-red-400'}>
                  {log.status === 'success' ? 'OK' : 'ERR'}
                </span>
                <span className="text-gray-500 text-xs">{log.latencyMs}ms</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wider">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}
