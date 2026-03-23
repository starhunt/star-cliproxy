import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n/context';
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
  success: 'bg-green-100 dark:bg-green-500/20 text-green-600 dark:text-green-400',
  error: 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400',
  timeout: 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-600 dark:text-yellow-400',
  cancelled: 'bg-gray-100 dark:bg-gray-500/20 text-gray-500 dark:text-gray-400',
};

// 페이지당 표시할 로그 수
const PAGE_SIZE = 20;

export default function LogsPage() {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = (newOffset: number) => {
    fetchLogs({ limit: PAGE_SIZE, offset: newOffset })
      .then((r) => {
        setLogs(r.data as LogItem[]);
        setOffset(newOffset);
        setTotal(r.pagination.total);
      })
      .catch((e) => setError(e.message));
  };

  useEffect(() => load(0), []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('logs.title')}</h2>
        <button
          onClick={() => load(0)}
          className="px-3 py-1.5 bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 rounded text-sm text-gray-500 dark:text-gray-400"
        >
          {t('common.refresh')}
        </button>
      </div>

      {error && <p className="text-red-500 dark:text-red-400 text-sm">{error}</p>}

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-800 text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wider">
              <th className="text-left px-4 py-3">{t('logs.time')}</th>
              <th className="text-left px-4 py-3">{t('logs.model')}</th>
              <th className="text-left px-4 py-3">{t('logs.provider')}</th>
              <th className="text-left px-4 py-3">{t('logs.actual')}</th>
              <th className="text-left px-4 py-3">{t('logs.status')}</th>
              <th className="text-left px-4 py-3">{t('logs.latency')}</th>
              <th className="text-left px-4 py-3">{t('logs.tokens')}</th>
              <th className="text-left px-4 py-3">{t('logs.stream')}</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id} className="border-b border-gray-100 dark:border-gray-800/50 hover:bg-gray-50 dark:hover:bg-gray-800/30">
                <td className="px-4 py-2.5 text-gray-400 dark:text-gray-500 font-mono text-xs">
                  {formatLogTime(log.createdAt)}
                </td>
                <td className="px-4 py-2.5 font-mono text-blue-600 dark:text-blue-400">{log.modelAlias}</td>
                <td className="px-4 py-2.5 capitalize text-gray-700 dark:text-gray-300">{log.provider}</td>
                <td className="px-4 py-2.5 font-mono text-gray-400 text-xs">{log.actualModel}</td>
                <td className="px-4 py-2.5">
                  <span className={`px-2 py-0.5 rounded text-xs ${statusBadge[log.status] ?? statusBadge.error}`}>
                    {log.status}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400">{log.latencyMs}ms</td>
                <td className="px-4 py-2.5 text-gray-400 dark:text-gray-500">{log.totalTokens ?? '-'}</td>
                <td className="px-4 py-2.5 text-gray-400 dark:text-gray-500">{log.isStream ? 'SSE' : '-'}</td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400 dark:text-gray-600">{t('logs.noLogs')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 페이지네이션 */}
      <div className="flex justify-between items-center">
        <button
          onClick={() => load(Math.max(0, offset - PAGE_SIZE))}
          disabled={offset === 0}
          className="px-3 py-1.5 bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 rounded text-sm disabled:opacity-30 disabled:cursor-not-allowed text-gray-700 dark:text-gray-200"
        >
          {t('common.previous')}
        </button>
        <span className="text-gray-400 dark:text-gray-500 text-sm">
          {logs.length > 0
            ? `${t('logs.showing')} ${offset + 1} - ${offset + logs.length} / ${total}`
            : t('logs.noLogs')}
        </span>
        <button
          onClick={() => load(offset + PAGE_SIZE)}
          disabled={offset + PAGE_SIZE >= total}
          className="px-3 py-1.5 bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 rounded text-sm disabled:opacity-30 disabled:cursor-not-allowed text-gray-700 dark:text-gray-200"
        >
          {t('common.next')}
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
