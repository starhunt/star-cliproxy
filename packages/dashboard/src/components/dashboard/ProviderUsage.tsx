import { useState } from 'react';
import { useTranslation } from '../../i18n/context';
import type { DashboardData } from '../../api/client';
import { compactNumber, formatDurationShort, latencyColor, successRateColor } from './format';

interface Props {
  providerStats: DashboardData['providerStats'];
}

const COMPACT_THRESHOLD = 6;
const DEFAULT_VISIBLE = 8;

type SortMode = 'usage' | 'latency' | 'errorRate';

export function ProviderUsage({ providerStats }: Props) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>('usage');

  if (providerStats.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-3">{t('dashboard.providerUsage')}</h3>
        <div className="h-16 flex items-center justify-center text-gray-400 dark:text-gray-600 text-sm">
          {t('common.noDataYet')}
        </div>
      </div>
    );
  }

  const sorted = [...providerStats].sort((a, b) => {
    if (sortMode === 'latency') return b.p95LatencyMs - a.p95LatencyMs;
    if (sortMode === 'errorRate') return a.successRate - b.successRate;
    return b.count - a.count;
  });

  const maxCount = Math.max(...sorted.map((p) => p.count), 1);
  const useCompact = sorted.length > COMPACT_THRESHOLD;
  const visible = showAll ? sorted : sorted.slice(0, useCompact ? DEFAULT_VISIBLE : sorted.length);

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400">{t('dashboard.providerUsage')}</h3>
        <div className="flex items-center gap-1 text-[11px]">
          <SortChip active={sortMode === 'usage'} onClick={() => setSortMode('usage')}>
            {t('dashboard.sortByUsage')}
          </SortChip>
          <SortChip active={sortMode === 'latency'} onClick={() => setSortMode('latency')}>
            P95
          </SortChip>
          <SortChip active={sortMode === 'errorRate'} onClick={() => setSortMode('errorRate')}>
            {t('dashboard.sortByErrors')}
          </SortChip>
        </div>
      </div>

      {useCompact ? (
        // 컴팩트 리스트: 한 줄에 사용량 막대 + 핵심 지표
        <div className="space-y-1">
          {visible.map((p) => (
            <CompactRow key={p.provider} p={p} maxCount={maxCount} t={t} />
          ))}
        </div>
      ) : (
        // 카드 그리드: 적은 데이터에 시각적 우선
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {visible.map((p) => (
            <CardItem key={p.provider} p={p} t={t} />
          ))}
        </div>
      )}

      {sorted.length > visible.length && !showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-3 w-full text-xs text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 py-1.5 border border-dashed border-gray-200 dark:border-gray-800 rounded-lg transition-colors"
        >
          {t('dashboard.showMoreCount', { count: sorted.length - visible.length })}
        </button>
      )}
      {showAll && sorted.length > DEFAULT_VISIBLE && (
        <button
          onClick={() => setShowAll(false)}
          className="mt-3 w-full text-xs text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 py-1.5 border border-dashed border-gray-200 dark:border-gray-800 rounded-lg transition-colors"
        >
          {t('dashboard.showLess')}
        </button>
      )}
    </div>
  );
}

function SortChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 rounded transition-colors ${
        active
          ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400'
          : 'text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400'
      }`}
    >
      {children}
    </button>
  );
}

function CompactRow({
  p,
  maxCount,
  t,
}: {
  p: DashboardData['providerStats'][number];
  maxCount: number;
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  const usagePct = (p.count / maxCount) * 100;
  const hasIssue = p.successRate < 95 && p.count >= 5;
  return (
    <div
      className={`grid grid-cols-[1fr_auto_auto_auto] sm:grid-cols-[1.4fr_2fr_auto_auto_auto] items-center gap-3 px-2 py-1.5 rounded text-xs hover:bg-gray-50 dark:hover:bg-gray-800/30 ${
        hasIssue ? 'bg-red-50/40 dark:bg-red-500/5' : ''
      }`}
    >
      <span className="text-gray-700 dark:text-gray-300 capitalize font-medium truncate">{p.provider}</span>
      <div className="hidden sm:block relative h-1.5 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden">
        <div className="absolute inset-y-0 left-0 bg-blue-500/60 rounded" style={{ width: `${usagePct}%` }} />
      </div>
      <span className="font-mono text-gray-600 dark:text-gray-300 tabular-nums w-12 text-right" title={t('dashboard.requests')}>
        {compactNumber(p.count)}
      </span>
      <span className={`font-mono tabular-nums w-12 text-right ${successRateColor(p.successRate)}`} title={t('dashboard.successRate')}>
        {p.successRate.toFixed(0)}%
      </span>
      <span className={`font-mono tabular-nums w-14 text-right ${latencyColor(p.p95LatencyMs)}`} title="P95">
        {formatDurationShort(p.p95LatencyMs)}
      </span>
    </div>
  );
}

function CardItem({
  p,
  t,
}: {
  p: DashboardData['providerStats'][number];
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  return (
    <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-500 dark:text-gray-400 capitalize truncate">{p.provider}</span>
        <span className={`text-[10px] font-mono ${successRateColor(p.successRate)}`}>{p.successRate.toFixed(0)}%</span>
      </div>
      <div className="text-xl font-bold text-gray-800 dark:text-gray-100">{compactNumber(p.count)}</div>
      <div className="text-xs text-gray-400 dark:text-gray-500 mt-1 flex items-center justify-between">
        <span>P95 {formatDurationShort(p.p95LatencyMs)}</span>
        <span title={t('dashboard.tokens')}>{compactNumber(p.totalTokens)}t</span>
      </div>
    </div>
  );
}
