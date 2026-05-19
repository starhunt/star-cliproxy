import { useState } from 'react';
import { useTranslation } from '../../i18n/context';
import type { DashboardData } from '../../api/client';
import { compactNumber, formatDurationShort, successRateColor } from './format';
import { buildColorMap, MUTED_COLOR } from './colors';

interface Props {
  popularModels: DashboardData['popularModels'];
}

const DEFAULT_LIMIT = 8;

export function PopularModels({ popularModels }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (popularModels.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-3">{t('dashboard.popularModels')}</h3>
        <div className="h-16 flex items-center justify-center text-gray-400 dark:text-gray-600 text-sm">
          {t('common.noDataYet')}
        </div>
      </div>
    );
  }

  const visible = expanded ? popularModels : popularModels.slice(0, DEFAULT_LIMIT);
  const totalCount = popularModels.reduce((sum, m) => sum + m.count, 0);
  const maxCount = Math.max(...popularModels.map((m) => m.count), 1);
  const colorMap = buildColorMap(popularModels.map((m) => m.modelAlias));

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400">{t('dashboard.popularModels')}</h3>
        <span className="text-[11px] text-gray-400 dark:text-gray-600">
          {popularModels.length} {t('dashboard.modelsCount')}
        </span>
      </div>

      <div className="space-y-1.5">
        {visible.map((m, i) => {
          const color = colorMap.get(m.modelAlias) ?? MUTED_COLOR;
          const sharePct = (m.count / totalCount) * 100;
          const widthPct = (m.count / maxCount) * 100;
          return (
            <div key={`${m.modelAlias}-${m.provider}`} className="flex items-center gap-3 text-xs">
              <span className="text-gray-400 dark:text-gray-600 w-4 text-right tabular-nums">{i + 1}</span>
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${color.dot}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-gray-700 dark:text-gray-300 font-mono truncate">{m.modelAlias}</span>
                  <span className="text-gray-400 dark:text-gray-500 text-[10px] shrink-0 hidden sm:inline">{m.provider}</span>
                </div>
                <div className="relative h-1 mt-1 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden">
                  <div className={`absolute inset-y-0 left-0 ${color.bar} rounded`} style={{ width: `${widthPct}%` }} />
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0 tabular-nums">
                <span className={`w-10 text-right ${successRateColor(m.successRate)}`}>
                  {m.successRate.toFixed(0)}%
                </span>
                <span className="text-gray-500 dark:text-gray-500 w-12 text-right" title={t('dashboard.avgLatency')}>
                  {formatDurationShort(m.avgLatencyMs)}
                </span>
                <span className="text-gray-600 dark:text-gray-300 w-12 text-right font-medium">{compactNumber(m.count)}</span>
                <span className="text-gray-400 dark:text-gray-600 w-10 text-right text-[10px]">{sharePct.toFixed(0)}%</span>
              </div>
            </div>
          );
        })}
      </div>

      {popularModels.length > DEFAULT_LIMIT && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-3 w-full text-xs text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 py-1.5 border border-dashed border-gray-200 dark:border-gray-800 rounded-lg transition-colors"
        >
          {expanded
            ? t('dashboard.showLess')
            : t('dashboard.showMoreCount', { count: popularModels.length - DEFAULT_LIMIT })}
        </button>
      )}
    </div>
  );
}
