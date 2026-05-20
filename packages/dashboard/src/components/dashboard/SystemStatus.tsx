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

type ProviderKind = 'builtin' | 'plugin' | 'http';

const COMPACT_THRESHOLD = 8;

// kind별 시각 토큰. 다른 컬러를 쓰는 이유: status(녹/빨/노)와 충돌하지 않게.
const KIND_STYLE: Record<ProviderKind, { chip: string; dot: string; pill: string; order: number }> = {
  builtin: {
    chip: 'bg-blue-100 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-300/60 dark:border-blue-500/30',
    dot: 'bg-blue-400 dark:bg-blue-500',
    pill: 'text-blue-600 dark:text-blue-400',
    order: 0,
  },
  plugin: {
    chip: 'bg-violet-100 dark:bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-300/60 dark:border-violet-500/30',
    dot: 'bg-violet-400 dark:bg-violet-500',
    pill: 'text-violet-600 dark:text-violet-400',
    order: 1,
  },
  http: {
    chip: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-300/60 dark:border-amber-500/30',
    dot: 'bg-amber-400 dark:bg-amber-500',
    pill: 'text-amber-600 dark:text-amber-400',
    order: 2,
  },
};

export function SystemStatus({ providers, cache, rateLimits, totalTokens }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const groups = useMemo(() => {
    const healthy = providers.filter((p) => p.status === 'healthy');
    const unhealthy = providers.filter((p) => p.status === 'unhealthy');
    const unknown = providers.filter((p) => p.status !== 'healthy' && p.status !== 'unhealthy');
    return { healthy, unhealthy, unknown };
  }, [providers]);

  // kind별 카운트 (요약 pill 2번째 줄)
  const kindCounts = useMemo(() => {
    return providers.reduce(
      (acc, p) => {
        const k = (p.kind ?? 'builtin') as ProviderKind;
        acc[k]++;
        return acc;
      },
      { builtin: 0, plugin: 0, http: 0 } as Record<ProviderKind, number>,
    );
  }, [providers]);

  // 펼침 모드에서 kind별로 그룹화한 정렬된 목록
  // 우선순위: 같은 kind 내에서 unhealthy → unknown → healthy 순으로 가독성 ↑
  const groupedByKind = useMemo(() => {
    const out: Record<ProviderKind, DashboardData['providers']> = { builtin: [], plugin: [], http: [] };
    const statusOrder = (s: string) => s === 'unhealthy' ? 0 : s === 'healthy' ? 2 : 1;
    for (const p of providers) {
      const k = (p.kind ?? 'builtin') as ProviderKind;
      out[k].push(p);
    }
    for (const k of Object.keys(out) as ProviderKind[]) {
      out[k].sort((a, b) => statusOrder(a.status) - statusOrder(b.status) || a.name.localeCompare(b.name));
    }
    return out;
  }, [providers]);

  const total = providers.length;
  const compactMode = total > COMPACT_THRESHOLD && !expanded;

  const statusLabel = (status: string) => {
    if (status === 'healthy') return t('common.online');
    if (status === 'unhealthy') return t('common.offline');
    return t('common.unknown');
  };

  const kindLabel = (k: ProviderKind) => t(`systemStatus.kind${k.charAt(0).toUpperCase()}${k.slice(1)}`);
  const kindShort = (k: ProviderKind) => t(`systemStatus.kind${k.charAt(0).toUpperCase()}${k.slice(1)}Short`);

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

      {/* 1행: 상태 요약 (online/offline/unknown) — 운영 우선순위가 높은 KPI */}
      <div className="grid grid-cols-3 gap-2 mb-2">
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

      {/* 2행: kind 분포 (기본/플러그인/HTTP) — 매핑 이해 보조 */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        {(['builtin', 'plugin', 'http'] as ProviderKind[]).map((k) => (
          <KindPill
            key={k}
            label={kindLabel(k)}
            count={kindCounts[k]}
            dot={KIND_STYLE[k].dot}
            tone={KIND_STYLE[k].pill}
          />
        ))}
      </div>

      {/* 문제가 있는 프로바이더는 항상 표시 (컴팩트 모드여도). kind chip 포함 */}
      {compactMode && groups.unhealthy.length > 0 && (
        <div className="space-y-1 mb-3 pb-3 border-b border-gray-200 dark:border-gray-800">
          <p className="text-[11px] uppercase tracking-wider text-red-500 dark:text-red-400 font-semibold mb-1">
            {t('dashboard.needsAttention')}
          </p>
          {groups.unhealthy.map((p) => (
            <ProviderRow key={p.name} p={p} statusLabel={statusLabel} kindShort={kindShort} />
          ))}
        </div>
      )}

      {/* 펼침 모드: kind별 서브헤더로 그룹 표시 */}
      {!compactMode && (
        <div className="space-y-3 mb-3 pb-3 border-b border-gray-200 dark:border-gray-800 max-h-72 overflow-y-auto pr-1">
          {(['builtin', 'plugin', 'http'] as ProviderKind[]).map((k) => {
            const list = groupedByKind[k];
            if (list.length === 0) return null;
            return (
              <div key={k}>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${KIND_STYLE[k].dot}`} />
                  <p className={`text-[11px] uppercase tracking-wider font-semibold ${KIND_STYLE[k].pill}`}>
                    {kindLabel(k)}
                  </p>
                  <span className="text-[11px] text-gray-400 dark:text-gray-500">·</span>
                  <span className="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums">{list.length}</span>
                </div>
                <div className="space-y-1.5 pl-3 border-l border-gray-200 dark:border-gray-800">
                  {list.map((p) => (
                    <ProviderRow key={p.name} p={p} statusLabel={statusLabel} kindShort={kindShort} hideKindChip />
                  ))}
                </div>
              </div>
            );
          })}
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

// kind 분포 pill — count가 0이면 dim 처리
function KindPill({ dot, count, label, tone }: { dot: string; count: number; label: string; tone: string }) {
  const dim = count === 0;
  return (
    <div className={`bg-gray-50 dark:bg-gray-800/40 rounded-lg px-2 py-1.5 flex items-center gap-1.5 ${dim ? 'opacity-50' : ''}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      <span className={`text-sm font-semibold tabular-nums ${dim ? 'text-gray-400 dark:text-gray-600' : tone}`}>{count}</span>
      <span className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{label}</span>
    </div>
  );
}

function ProviderRow({
  p,
  statusLabel,
  kindShort,
  hideKindChip = false,
}: {
  p: DashboardData['providers'][number];
  statusLabel: (s: string) => string;
  kindShort: (k: ProviderKind) => string;
  hideKindChip?: boolean;
}) {
  const queueBusy = p.queue && p.queue.pending > 0;
  const kind = (p.kind ?? 'builtin') as ProviderKind;
  return (
    <div className="flex items-center justify-between text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[p.status] ?? STATUS_DOT.unknown}`} />
        {/* kind 칩 — 그룹화된 영역에서는 중복이라 숨김 */}
        {!hideKindChip && (
          <span
            className={`text-[9px] font-bold uppercase px-1 py-0.5 rounded border shrink-0 ${KIND_STYLE[kind].chip}`}
            title={kindShort(kind)}
          >
            {kindShort(kind)}
          </span>
        )}
        <span className="text-gray-700 dark:text-gray-300 truncate font-mono text-xs">{p.name}</span>
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
