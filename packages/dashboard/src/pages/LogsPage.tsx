import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n/context';
import { fetchLogs, deleteLogsByAge } from '../api/client';

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

const PAGE_SIZE = 20;

export default function LogsPage() {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [deleteDays, setDeleteDays] = useState(30);
  const [deleting, setDeleting] = useState(false);

  const load = (p: number) => {
    fetchLogs({ limit: PAGE_SIZE, offset: p * PAGE_SIZE })
      .then((r) => {
        setLogs(r.data as LogItem[]);
        setPage(p);
        setTotal(r.pagination.total);
      })
      .catch((e) => setError(e.message));
  };

  useEffect(() => load(0), []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleDeleteOldLogs = async () => {
    if (!confirm(t('logs.confirmDelete').replace('{days}', String(deleteDays)))) return;
    setDeleting(true);
    setMessage(null);
    try {
      const result = await deleteLogsByAge(deleteDays);
      setMessage({
        type: 'success',
        text: t('logs.deleteSuccess')
          .replace('{count}', String(result.deleted))
          .replace('{days}', String(deleteDays)),
      });
      load(0);
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('logs.title')}</h2>
          <span className="text-xs text-gray-400 dark:text-gray-500">{total} {t('logs.entries')}</span>
        </div>
        <div className="flex items-center gap-2">
          {/* 기간별 삭제 */}
          <div className="flex items-center gap-1.5 bg-gray-100 dark:bg-gray-800 rounded-lg px-2 py-1">
            <select
              value={deleteDays}
              onChange={(e) => setDeleteDays(Number(e.target.value))}
              className="bg-transparent text-xs text-gray-600 dark:text-gray-300 border-none outline-none cursor-pointer"
            >
              <option value={7}>7{t('logs.daysAgo')}</option>
              <option value={14}>14{t('logs.daysAgo')}</option>
              <option value={30}>30{t('logs.daysAgo')}</option>
              <option value={60}>60{t('logs.daysAgo')}</option>
              <option value={90}>90{t('logs.daysAgo')}</option>
            </select>
            <button
              onClick={handleDeleteOldLogs}
              disabled={deleting}
              className="px-2 py-0.5 bg-red-100 dark:bg-red-900/50 hover:bg-red-200 dark:hover:bg-red-800/50 text-red-600 dark:text-red-400 rounded text-xs transition-colors disabled:opacity-40"
            >
              {deleting ? '...' : t('logs.deleteOld')}
            </button>
          </div>
          <button
            onClick={() => load(0)}
            className="px-3 py-1.5 bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 rounded text-sm text-gray-500 dark:text-gray-400"
          >
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {error && <p className="text-red-500 dark:text-red-400 text-sm">{error}</p>}

      {message && (
        <div className={`px-4 py-2 rounded-lg border text-sm ${
          message.type === 'success'
            ? 'bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/30 text-green-600 dark:text-green-400'
            : 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-600 dark:text-red-400'
        }`}>
          {message.text}
        </div>
      )}

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
      {totalPages > 1 && (
        <Pagination currentPage={page} totalPages={totalPages} onPageChange={(p) => load(p)} />
      )}
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

// 페이지 번호 목록 생성
function getPageNumbers(current: number, total: number): (number | '...')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const pages: (number | '...')[] = [0];
  const start = Math.max(1, current - 1);
  const end = Math.min(total - 2, current + 1);
  if (start > 1) pages.push('...');
  for (let i = start; i <= end; i++) pages.push(i);
  if (end < total - 2) pages.push('...');
  pages.push(total - 1);
  return pages;
}

function Pagination({ currentPage, totalPages, onPageChange }: {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  const btnBase = 'px-2.5 py-1 rounded text-xs transition-colors';
  const btnNav = `${btnBase} bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 disabled:opacity-40 disabled:pointer-events-none`;
  const btnPage = (active: boolean) =>
    active
      ? `${btnBase} bg-blue-600 text-white`
      : `${btnBase} bg-gray-100 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300`;

  const pages = getPageNumbers(currentPage, totalPages);

  return (
    <div className="flex items-center justify-center gap-1">
      <button onClick={() => onPageChange(0)} disabled={currentPage === 0} className={btnNav}>«</button>
      <button onClick={() => onPageChange(currentPage - 1)} disabled={currentPage === 0} className={btnNav}>‹</button>
      {pages.map((p, i) =>
        p === '...' ? (
          <span key={`ellipsis-${i}`} className="px-1.5 text-xs text-gray-400 dark:text-gray-600">…</span>
        ) : (
          <button key={p} onClick={() => onPageChange(p)} className={btnPage(p === currentPage)}>
            {p + 1}
          </button>
        ),
      )}
      <button onClick={() => onPageChange(currentPage + 1)} disabled={currentPage >= totalPages - 1} className={btnNav}>›</button>
      <button onClick={() => onPageChange(totalPages - 1)} disabled={currentPage >= totalPages - 1} className={btnNav}>»</button>
    </div>
  );
}
