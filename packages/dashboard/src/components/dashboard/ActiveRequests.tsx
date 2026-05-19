import { useTranslation } from '../../i18n/context';
import type { DashboardData } from '../../api/client';
import { formatDurationShort } from './format';

interface Props {
  activeRequests: DashboardData['activeRequests'];
}

export function ActiveRequests({ activeRequests }: Props) {
  const { t } = useTranslation();
  if (activeRequests.count === 0) return null;

  return (
    <div className="bg-white dark:bg-gray-900 border border-blue-200 dark:border-blue-500/30 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="relative flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500" />
        </span>
        <h3 className="text-sm font-semibold text-blue-600 dark:text-blue-400">
          {t(
            activeRequests.count > 1 ? 'dashboard.processingRequestsPlural' : 'dashboard.processingRequests',
            { count: activeRequests.count },
          )}
        </h3>
      </div>
      <div className="space-y-1.5">
        {activeRequests.requests.map((req) => {
          const slow = req.elapsedMs > 30000;
          const medium = req.elapsedMs > 10000;
          return (
            <div
              key={req.requestId}
              className="flex items-center justify-between py-2 px-3 bg-blue-50 dark:bg-blue-500/5 border border-blue-100 dark:border-blue-500/10 rounded-lg text-xs"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin shrink-0" />
                <span className="text-gray-700 dark:text-gray-300 font-mono truncate">{req.modelAlias}</span>
                <span className="text-gray-400 dark:text-gray-500 truncate">{req.provider}</span>
                <span className="text-gray-500 dark:text-gray-600 font-mono truncate hidden md:inline">{req.actualModel}</span>
                {req.reasoningEffort && (
                  <span
                    className="px-1.5 py-0.5 rounded font-mono bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-300 shrink-0"
                    title="reasoning_effort"
                  >
                    {req.reasoningEffort}
                  </span>
                )}
                {req.isStream && (
                  <span className="px-1.5 py-0.5 bg-purple-100 dark:bg-purple-500/20 text-purple-600 dark:text-purple-400 rounded text-xs shrink-0">
                    SSE
                  </span>
                )}
              </div>
              <span
                className={`font-mono shrink-0 ml-2 ${
                  slow ? 'text-red-400' : medium ? 'text-yellow-400' : 'text-blue-500 dark:text-blue-400'
                }`}
              >
                {formatDurationShort(req.elapsedMs)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
