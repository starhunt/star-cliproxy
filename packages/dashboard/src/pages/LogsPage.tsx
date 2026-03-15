import { useEffect, useState } from 'react';
import { fetchLogs } from '../api/client';

interface LogItem {
  id: string;
  requestId: string;
  modelAlias: string;
  provider: string;
  actualModel: string;
  status: string;
  latencyMs: number;
  ttfbMs: number | null;
  isStream: boolean;
  totalTokens: number | null;
  errorMessage: string | null;
  createdAt: string;
}

const statusBadge: Record<string, string> = {
  success: 'bg-green-500/20 text-green-400',
  error: 'bg-red-500/20 text-red-400',
  timeout: 'bg-yellow-500/20 text-yellow-400',
  cancelled: 'bg-gray-500/20 text-gray-400',
};

export default function LogsPage() {
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const limit = 50;

  const load = (newOffset: number) => {
    fetchLogs({ limit, offset: newOffset })
      .then((r) => {
        setLogs(r.data as LogItem[]);
        setOffset(newOffset);
      })
      .catch((e) => setError(e.message));
  };

  useEffect(() => load(0), []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Request Logs</h2>
        <button
          onClick={() => load(0)}
          className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-sm text-gray-400"
        >
          Refresh
        </button>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wider">
              <th className="text-left px-4 py-3">Time</th>
              <th className="text-left px-4 py-3">Model</th>
              <th className="text-left px-4 py-3">Provider</th>
              <th className="text-left px-4 py-3">Actual</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-left px-4 py-3">Latency</th>
              <th className="text-left px-4 py-3">Tokens</th>
              <th className="text-left px-4 py-3">Stream</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                <td className="px-4 py-2.5 text-gray-500 font-mono text-xs">
                  {formatLogTime(log.createdAt)}
                </td>
                <td className="px-4 py-2.5 font-mono text-blue-400">{log.modelAlias}</td>
                <td className="px-4 py-2.5 capitalize">{log.provider}</td>
                <td className="px-4 py-2.5 font-mono text-gray-400 text-xs">{log.actualModel}</td>
                <td className="px-4 py-2.5">
                  <span className={`px-2 py-0.5 rounded text-xs ${statusBadge[log.status] ?? statusBadge.error}`}>
                    {log.status}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-gray-400">{log.latencyMs}ms</td>
                <td className="px-4 py-2.5 text-gray-500">{log.totalTokens ?? '-'}</td>
                <td className="px-4 py-2.5 text-gray-500">{log.isStream ? 'SSE' : '-'}</td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-600">No logs yet</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex justify-between items-center">
        <button
          onClick={() => load(Math.max(0, offset - limit))}
          disabled={offset === 0}
          className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-sm disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Previous
        </button>
        <span className="text-gray-500 text-sm">
          Showing {offset + 1} - {offset + logs.length}
        </span>
        <button
          onClick={() => load(offset + limit)}
          disabled={logs.length < limit}
          className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-sm disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function formatLogTime(dateStr: string): string {
  if (!dateStr || dateStr.includes('datetime')) return '-';
  const normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString();
}
