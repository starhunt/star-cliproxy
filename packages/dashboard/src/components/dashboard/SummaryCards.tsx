import { useTranslation } from '../../i18n/context';
import type { DashboardData } from '../../api/client';
import { compactNumber, formatDuration, formatDurationShort, successRateColor } from './format';

type Accent = 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'amber';

const accentBorder: Record<Accent, string> = {
  blue: 'border-blue-200 dark:border-blue-500/30',
  green: 'border-green-200 dark:border-green-500/30',
  yellow: 'border-yellow-200 dark:border-yellow-500/30',
  red: 'border-red-200 dark:border-red-500/30',
  purple: 'border-purple-200 dark:border-purple-500/30',
  amber: 'border-amber-200 dark:border-amber-500/30',
};

const accentValue: Record<Accent, string> = {
  blue: 'text-blue-600 dark:text-blue-400',
  green: 'text-green-600 dark:text-green-400',
  yellow: 'text-yellow-600 dark:text-yellow-400',
  red: 'text-red-600 dark:text-red-400',
  purple: 'text-purple-600 dark:text-purple-400',
  amber: 'text-amber-600 dark:text-amber-400',
};

interface SummaryCardProps {
  label: string;
  value: string;
  sub?: React.ReactNode;
  accent: Accent;
  valueClass?: string; // accent와 다른 값 색상이 필요할 때
}

function SummaryCard({ label, value, sub, accent, valueClass }: SummaryCardProps) {
  return (
    <div className={`bg-white dark:bg-gray-900 border ${accentBorder[accent]} rounded-xl p-4`}>
      <div className="text-xs text-gray-400 dark:text-gray-500 uppercase tracking-wider">{label}</div>
      <div className={`text-2xl font-bold mt-2 ${valueClass ?? accentValue[accent]}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 dark:text-gray-600 mt-1">{sub}</div>}
    </div>
  );
}

interface Props {
  data: DashboardData;
}

export function SummaryCards({ data }: Props) {
  const { t } = useTranslation();
  const { overview, today, apiKeys, modelMappings } = data;
  const failed = overview.errorCount + overview.timeoutCount;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <SummaryCard
        label={t('dashboard.totalRequests')}
        value={compactNumber(overview.totalRequests)}
        sub={`${t('dashboard.today')}: ${today.count.toLocaleString()}`}
        accent="blue"
      />
      <SummaryCard
        label={t('dashboard.successRate')}
        value={`${overview.successRate.toFixed(1)}%`}
        sub={
          <span>
            <span className="text-green-500 dark:text-green-400">{compactNumber(overview.successCount)}</span>
            <span> / </span>
            <span className="text-red-500 dark:text-red-400">{compactNumber(failed)}</span>
            {' '}{t('dashboard.failed')}
          </span>
        }
        accent={overview.successRate >= 95 ? 'green' : overview.successRate >= 80 ? 'yellow' : 'red'}
        valueClass={successRateColor(overview.successRate)}
      />
      <SummaryCard
        label={t('dashboard.latency')}
        value={formatDurationShort(overview.p50LatencyMs)}
        sub={
          <span className="flex items-center gap-2">
            <span><span className="text-gray-500">P50</span> {formatDurationShort(overview.p50LatencyMs)}</span>
            <span className="text-gray-300 dark:text-gray-700">·</span>
            <span><span className="text-gray-500">P95</span> {formatDurationShort(overview.p95LatencyMs)}</span>
            <span className="text-gray-300 dark:text-gray-700">·</span>
            <span><span className="text-gray-500">{t('dashboard.avg')}</span> {formatDurationShort(overview.avgLatencyMs)}</span>
          </span>
        }
        accent="purple"
      />
      <SummaryCard
        label={t('dashboard.tokensProcessed')}
        value={compactNumber(overview.totalTokens)}
        sub={
          <span className="flex items-center gap-2">
            <span><span className="text-gray-500">{t('dashboard.prompt')}</span> {compactNumber(overview.totalPromptTokens)}</span>
            <span className="text-gray-300 dark:text-gray-700">·</span>
            <span><span className="text-gray-500">{t('dashboard.completion')}</span> {compactNumber(overview.totalCompletionTokens)}</span>
          </span>
        }
        accent="amber"
      />
      {/* 작은 보조 카드 행 — 키/매핑 */}
      <div className="col-span-full flex flex-wrap items-center gap-x-6 gap-y-2 px-1 text-xs">
        <span className="text-gray-400 dark:text-gray-500">
          <span className="text-gray-700 dark:text-gray-200 font-medium">{apiKeys.active}</span>
          <span className="text-gray-400 dark:text-gray-600">/{apiKeys.total}</span> {t('dashboard.activeApiKeys')}
        </span>
        <span className="text-gray-400 dark:text-gray-500">
          <span className="text-gray-700 dark:text-gray-200 font-medium">{modelMappings.active}</span>
          <span className="text-gray-400 dark:text-gray-600">/{modelMappings.total}</span> {t('dashboard.modelMappings')}
        </span>
        <span className="text-gray-400 dark:text-gray-500">
          <span className="text-gray-700 dark:text-gray-200 font-medium">{compactNumber(overview.streamCount)}</span> {t('dashboard.streaming')}
        </span>
        <span className="text-gray-400 dark:text-gray-500">
          {t('dashboard.todayAvg')}: <span className="text-gray-700 dark:text-gray-200">{formatDuration(today.avgLatencyMs)}</span>
        </span>
      </div>
    </div>
  );
}
