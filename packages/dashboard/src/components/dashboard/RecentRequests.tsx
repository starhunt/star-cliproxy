import { useNavigate } from 'react-router-dom';
import { useTranslation } from '../../i18n/context';
import type { DashboardData } from '../../api/client';
import { formatTime, formatDurationShort } from './format';
import { REQUEST_STATUS_STYLE } from './colors';

interface Props {
  recentRequests: DashboardData['recentRequests'];
  activeRequests: DashboardData['activeRequests'];
}

export function RecentRequests({ recentRequests, activeRequests }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isEmpty = recentRequests.length === 0 && activeRequests.count === 0;

  return (
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

      {isEmpty ? (
        <div className="h-32 flex items-center justify-center text-gray-400 dark:text-gray-600 text-sm">
          {t('dashboard.noRequests')}
        </div>
      ) : (
        <div className="space-y-1">
          {activeRequests.requests.map((req) => (
            <div
              key={req.requestId}
              className="py-1.5 px-3 rounded text-xs bg-blue-50 dark:bg-blue-500/5 border border-blue-100 dark:border-blue-500/20"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin shrink-0" />
                  <span className="text-blue-600 dark:text-blue-300 font-mono truncate">{req.modelAlias}</span>
                  <span className="text-gray-500 dark:text-gray-600 truncate hidden sm:inline">{req.provider}</span>
                  {req.reasoningEffort && (
                    <span
                      className="px-1 py-0.5 rounded font-mono bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-300 text-[10px] shrink-0"
                      title="reasoning_effort"
                    >
                      {req.reasoningEffort}
                    </span>
                  )}
                  {req.isStream && (
                    <span className="px-1 py-0.5 bg-purple-100 dark:bg-purple-500/20 text-purple-600 dark:text-purple-400 rounded text-[10px] shrink-0">
                      SSE
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-blue-500 dark:text-blue-400 animate-pulse">{t('common.processing')}</span>
                  <span
                    className={`w-16 text-right font-mono tabular-nums ${
                      req.elapsedMs > 30000 ? 'text-red-400' : 'text-gray-500 dark:text-gray-600'
                    }`}
                  >
                    {formatDurationShort(req.elapsedMs)}
                  </span>
                </div>
              </div>
            </div>
          ))}
          {recentRequests.map((req) => (
            <div
              key={req.id}
              className={`py-1.5 px-3 rounded text-xs ${
                req.status !== 'success'
                  ? 'bg-red-50 dark:bg-red-500/5 border border-red-200 dark:border-red-500/20'
                  : 'bg-gray-50 dark:bg-gray-800/30'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-gray-500 dark:text-gray-600 font-mono w-14 shrink-0">
                    {formatTime(req.createdAt)}
                  </span>
                  <span className="text-gray-700 dark:text-gray-300 font-mono truncate">{req.modelAlias}</span>
                  <span className="text-gray-500 dark:text-gray-600 truncate hidden sm:inline">{req.provider}</span>
                  {req.reasoningEffort && (
                    <span
                      className="px-1 py-0.5 rounded font-mono bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-300 text-[10px] shrink-0"
                      title="reasoning_effort"
                    >
                      {req.reasoningEffort}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={REQUEST_STATUS_STYLE[req.status] ?? 'text-gray-400'}>{req.status}</span>
                  <span className="text-gray-500 dark:text-gray-600 w-16 text-right font-mono tabular-nums">
                    {formatDurationShort(req.latencyMs ?? 0)}
                  </span>
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
  );
}
