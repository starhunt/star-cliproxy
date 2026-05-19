import { useState } from 'react';
import { useTranslation } from '../../i18n/context';
import type { DashboardData } from '../../api/client';
import { formatTime, formatDurationShort } from './format';

interface Props {
  recentErrors: DashboardData['recentErrors'];
}

const PREVIEW_LIMIT = 3;

export function RecentErrors({ recentErrors }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (recentErrors.length === 0) return null;

  const visible = expanded ? recentErrors : recentErrors.slice(0, PREVIEW_LIMIT);

  return (
    <div className="bg-white dark:bg-gray-900 border border-red-200 dark:border-red-500/20 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-red-500 dark:text-red-400">{t('dashboard.recentErrors')}</h3>
        {recentErrors.length > PREVIEW_LIMIT && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 transition-colors"
          >
            {expanded
              ? t('dashboard.showLess')
              : t('dashboard.showMoreCount', { count: recentErrors.length - PREVIEW_LIMIT })}
          </button>
        )}
      </div>

      <div className="space-y-2">
        {visible.map((err) => (
          <div
            key={err.id}
            className="bg-red-50 dark:bg-red-500/5 border border-red-100 dark:border-red-500/10 rounded-lg px-4 py-2.5"
          >
            <div className="flex items-center justify-between gap-2 text-xs flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-gray-500 dark:text-gray-600 font-mono shrink-0">{formatTime(err.createdAt)}</span>
                <span className="text-gray-700 dark:text-gray-300 font-mono truncate">{err.modelAlias}</span>
                <span className="text-gray-500 dark:text-gray-600 truncate">{err.provider}</span>
                {err.reasoningEffort && (
                  <span
                    className="px-1 py-0.5 rounded font-mono bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-300 text-[10px] shrink-0"
                    title="reasoning_effort"
                  >
                    {err.reasoningEffort}
                  </span>
                )}
                <span
                  className={`px-1.5 py-0.5 rounded shrink-0 ${
                    err.status === 'timeout'
                      ? 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-600 dark:text-yellow-400'
                      : 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                  }`}
                >
                  {err.status}
                </span>
              </div>
              <span className="text-gray-500 dark:text-gray-600 font-mono tabular-nums">
                {formatDurationShort(err.latencyMs ?? 0)}
              </span>
            </div>
            {err.errorMessage && (
              <p className="text-xs text-red-400 dark:text-red-300/70 mt-1.5 break-all">{err.errorMessage}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
