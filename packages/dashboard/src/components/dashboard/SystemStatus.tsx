import { useMemo, useState } from 'react';
import { useTranslation } from '../../i18n/context';
import type { DashboardData } from '../../api/client';
import { compactNumber } from './format';
import { STATUS_DOT } from './colors';

interface Props {
  providers: DashboardData['providers'];
  cache: DashboardData['cache'];
  rateLimits: DashboardData['rateLimits'];
  totalTokens: number;
}

const COMPACT_THRESHOLD = 8;

export function SystemStatus({ providers, cache, rateLimits, totalTokens }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const groups = useMemo(() => {
    const healthy = providers.filter((p) => p.status === 'healthy');
    const unhealthy = providers.filter((p) => p.status === 'unhealthy');
    const unknown = providers.filter((p) => p.status !== 'healthy' && p.status !== 'unhealthy');
    return { healthy, unhealthy, unknown };
  }, [providers]);

  const total = providers.length;
  const compactMode = total > COMPACT_THRESHOLD && !expanded;

  const statusLabel = (status: string) => {
    if (status === 'healthy') return t('common.online');
    if (status === 'unhealthy') return t('common.offline');
    return t('common.unknown');
  };

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400">{t('dashboard.systemStatus')}</h3>
        {total > COMPACT_THRESHOLD && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-gray-400 dark:text-gray-500 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
          >
            {expanded ? t('dashboard.collapse') : t('dashboard.expandAll')}
          </button>
        )}
      </div>

      {/* 요약 행 (항상 표시) */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <SummaryPill
          dot="bg-green-400"
          count={groups.healthy.length}
          label={t('common.online')}
          tone="green"
        />
        <SummaryPill
          dot="bg-red-400"
          count={groups.unhealthy.length}
          label={t('common.offline')}
          tone="red"
        />
        <SummaryPill
          dot="bg-yellow-400"
          count={groups.unknown.length}
          label={t('common.unknown')}
          tone="yellow"
        />
      </div>

      {/* 문제가 있는 프로바이더는 항상 표시 (컴팩트 모드여도) */}
      {compactMode && groups.unhealthy.length > 0 && (
        <div className="space-y-2 mb-3 pb-3 border-b border-gray-200 dark:border-gray-800">
          <p className="text-[11px] uppercase tracking-wider text-red-500 dark:text-red-400 font-semibold">
            {t('dashboard.needsAttention')}
          </p>
          {groups.unhealthy.map((p) => <ProviderRow key={p.name} p={p} statusLabel={statusLabel} />)}
        </div>
      )}

      {/* 펼침 모드: 전체 리스트. 컴팩트 모드: 숨김 */}
      {!compactMode && (
        <div className="space-y-2 mb-3 pb-3 border-b border-gray-200 dark:border-gray-800 max-h-72 overflow-y-auto pr-1">
          {[...groups.unhealthy, ...groups.unknown, ...groups.healthy].map((p) => (
            <ProviderRow key={p.name} p={p} statusLabel={statusLabel} />
          ))}
        </div>
      )}

      {/* 메타 정보 */}
      <div className="space-y-1.5 text-xs">
        <Meta label={t('dashboard.cache')} value={`${cache.activeEntries} ${t('dashboard.entries')}`} />
        <Meta label={t('dashboard.rateLimit')} value={`${rateLimits.global.rpm} RPM / ${rateLimits.global.rpd} RPD`} />
        <Meta label={t('dashboard.totalTokens')} value={compactNumber(totalTokens)} />
      </div>
    </div>
  );
}

function SummaryPill({ dot, count, label, tone }: { dot: string; count: number; label: string; tone: 'green' | 'red' | 'yellow' }) {
  const toneClass = {
    green: 'text-green-600 dark:text-green-400',
    red: count > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-400 dark:text-gray-600',
    yellow: count > 0 ? 'text-yellow-600 dark:text-yellow-400' : 'text-gray-400 dark:text-gray-600',
  }[tone];
  return (
    <div className="bg-gray-50 dark:bg-gray-800/40 rounded-lg p-2 flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      <span className={`text-lg font-bold ${toneClass}`}>{count}</span>
      <span className="text-xs text-gray-400 dark:text-gray-500">{label}</span>
    </div>
  );
}

function ProviderRow({
  p,
  statusLabel,
}: {
  p: DashboardData['providers'][number];
  statusLabel: (s: string) => string;
}) {
  const queueBusy = p.queue && p.queue.pending > 0;
  return (
    <div className="flex items-center justify-between text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[p.status] ?? STATUS_DOT.unknown}`} />
        <span className="text-gray-700 dark:text-gray-300 capitalize truncate">{p.name}</span>
        {queueBusy && (
          <span className="text-[10px] px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 shrink-0">
            {p.queue!.pending}+
          </span>
        )}
      </div>
      <span
        className={`text-xs shrink-0 ${
          p.status === 'healthy'
            ? 'text-green-500 dark:text-green-400'
            : p.status === 'unhealthy'
              ? 'text-red-500 dark:text-red-400'
              : 'text-yellow-500 dark:text-yellow-400'
        }`}
      >
        {statusLabel(p.status)}
      </span>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <span className="text-gray-400 dark:text-gray-500 font-mono">{value}</span>
    </div>
  );
}
