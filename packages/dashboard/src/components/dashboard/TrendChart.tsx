import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../../i18n/context';
import { fetchTrend, type TrendData } from '../../api/client';
import { buildColorMap, MUTED_COLOR } from './colors';
import { compactNumber } from './format';

type ViewMode = 'requests' | 'tokens';

const RANGE_OPTIONS = [
  { label: '6h', hours: 6 },
  { label: '12h', hours: 12 },
  { label: '24h', hours: 24 },
  { label: '3d', hours: 72 },
  { label: '7d', hours: 168 },
];

const BAR_MAX_HEIGHT = 120;
const TOP_LEGEND_LIMIT = 12;

export function TrendChart() {
  const { t } = useTranslation();
  const [hours, setHours] = useState(24);
  const [mode, setMode] = useState<ViewMode>('requests');
  const [data, setData] = useState<TrendData | null>(null);
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(new Set());
  const [legendExpanded, setLegendExpanded] = useState(false);

  const load = useCallback(() => {
    fetchTrend(hours).then(setData).catch(() => {});
  }, [hours]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (!data) {
    return (
      <div className="h-40 flex items-center justify-center text-gray-400 dark:text-gray-600 text-sm">
        {t('common.loading')}
      </div>
    );
  }

  // 모델 사용량 내림차순
  const modelCounts = new Map<string, number>();
  data.byModel.forEach((d) => modelCounts.set(d.modelAlias, (modelCounts.get(d.modelAlias) ?? 0) + d.count));
  const allModels = [...modelCounts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const colorMap = buildColorMap(allModels, TOP_LEGEND_LIMIT);
  const visibleModels = allModels.filter((m) => !hiddenModels.has(m));

  // 시간 슬롯 생성
  const now = new Date();
  const slots = Array.from({ length: hours }, (_, i) => {
    const d = new Date(now.getTime() - (hours - 1 - i) * 3600_000);
    const slotKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}`;

    const match = data.trend.find((item) => item.slot === slotKey);
    const modelBreakdown = visibleModels
      .map((model) => {
        const entry = data.byModel.find((b) => b.slot === slotKey && b.modelAlias === model);
        return { model, count: entry?.count ?? 0 };
      })
      .filter((m) => m.count > 0);

    const visibleCount = modelBreakdown.reduce((sum, m) => sum + m.count, 0);

    return {
      key: slotKey,
      localHour: d.getHours(),
      localDate: d,
      totalCount: match?.count ?? 0,
      visibleCount,
      errorCount: match?.errorCount ?? 0,
      tokens: match?.tokens ?? 0,
      models: modelBreakdown,
    };
  });

  // 모드별 최대값
  const maxValue = mode === 'tokens'
    ? Math.max(...slots.map((s) => s.tokens), 1)
    : Math.max(...slots.map((s) => s.visibleCount), 1);

  // 합계 (헤더 표시용)
  const totalRequests = slots.reduce((sum, s) => sum + s.visibleCount, 0);
  const totalTokens = slots.reduce((sum, s) => sum + s.tokens, 0);
  const totalErrors = slots.reduce((sum, s) => sum + s.errorCount, 0);

  // 라벨 간격
  const labelInterval = hours <= 12 ? 1 : hours <= 24 ? 2 : hours <= 72 ? 6 : 12;
  const showDateLabels = hours > 24;

  const toggleModel = (model: string) => {
    setHiddenModels((prev) => {
      const next = new Set(prev);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });
  };
  const showAll = () => setHiddenModels(new Set());
  const allVisible = hiddenModels.size === 0;

  const legendModels = legendExpanded ? allModels : allModels.slice(0, TOP_LEGEND_LIMIT);

  return (
    <div>
      {/* 헤더: 타이틀 + 모드/기간 토글 */}
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400">{t('dashboard.requestTrend')}</h3>
          <div className="flex items-center gap-1 text-[11px]">
            <ModeChip active={mode === 'requests'} onClick={() => setMode('requests')}>
              {t('dashboard.requests')}
            </ModeChip>
            <ModeChip active={mode === 'tokens'} onClick={() => setMode('tokens')}>
              {t('dashboard.tokens')}
            </ModeChip>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.hours}
              onClick={() => setHours(opt.hours)}
              className={`px-2 py-0.5 rounded text-xs transition-colors ${
                hours === opt.hours
                  ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400'
                  : 'text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* 통계 행 */}
      <div className="flex items-center justify-end gap-3 text-xs text-gray-400 dark:text-gray-600 mb-2">
        <span>
          <span className="text-gray-700 dark:text-gray-300 font-medium">{compactNumber(totalRequests)}</span>{' '}
          {t('dashboard.requests')}
        </span>
        <span className="text-gray-300 dark:text-gray-700">·</span>
        <span>
          <span className="text-gray-700 dark:text-gray-300 font-medium">{compactNumber(totalTokens)}</span>{' '}
          {t('dashboard.tokens')}
        </span>
        {totalErrors > 0 && (
          <>
            <span className="text-gray-300 dark:text-gray-700">·</span>
            <span className="text-red-500 dark:text-red-400">
              <span className="font-medium">{totalErrors}</span> {t('common.errors')}
            </span>
          </>
        )}
        {hiddenModels.size > 0 && <span className="text-gray-300 dark:text-gray-700">{t('common.filtered')}</span>}
      </div>

      {/* 바 차트 */}
      <div className="flex items-end gap-px" style={{ height: `${BAR_MAX_HEIGHT}px` }}>
        {slots.map((slot, idx) => {
          const value = mode === 'tokens' ? slot.tokens : slot.visibleCount;
          const totalPx = Math.round((value / maxValue) * BAR_MAX_HEIGHT);
          const errorRate = slot.totalCount > 0 ? slot.errorCount / slot.totalCount : 0;
          const errorHeightPx = Math.min(Math.round(errorRate * BAR_MAX_HEIGHT * 0.3), totalPx); // 에러율 최대 30% 표시

          return (
            <div key={idx} className="flex-1 flex flex-col justify-end relative group cursor-default min-w-0">
              {value > 0 ? (
                <div className="w-full flex flex-col justify-end" style={{ height: `${totalPx}px` }}>
                  {mode === 'tokens' ? (
                    // 토큰 모드: 단일 막대
                    <div className="w-full bg-amber-500/70 rounded-sm" style={{ height: `${totalPx}px` }} />
                  ) : (
                    // 요청 모드: 모델별 스택
                    slot.models.map((m, mi) => {
                      const segPx = Math.max(Math.round((m.count / slot.visibleCount) * totalPx), 1);
                      const color = colorMap.get(m.model) ?? MUTED_COLOR;
                      return (
                        <div
                          key={m.model}
                          className={`w-full ${color.bar} ${mi === 0 ? 'rounded-t-sm' : ''} ${
                            mi === slot.models.length - 1 ? 'rounded-b-sm' : ''
                          }`}
                          style={{ height: `${segPx}px` }}
                        />
                      );
                    })
                  )}
                  {/* 에러 오버레이: 상단에 빨간 점 (요청 모드에서만) */}
                  {mode === 'requests' && slot.errorCount > 0 && (
                    <div
                      className="absolute left-0 right-0 bg-red-500/80 rounded-sm pointer-events-none"
                      style={{ bottom: `${totalPx}px`, height: `${Math.max(errorHeightPx, 2)}px` }}
                      title={`${slot.errorCount} errors`}
                    />
                  )}
                </div>
              ) : (
                <div className="w-full bg-gray-200 dark:bg-gray-800/20 rounded-sm" style={{ height: '1px' }} />
              )}

              {/* 툴팁 */}
              <div className="absolute -top-2 left-1/2 -translate-x-1/2 -translate-y-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-xs px-2 py-1 rounded shadow-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-20 min-w-[120px]">
                <div className="font-semibold mb-0.5">
                  {showDateLabels
                    ? `${slot.localDate.getMonth() + 1}/${slot.localDate.getDate()} ${String(slot.localHour).padStart(2, '0')}:00`
                    : `${String(slot.localHour).padStart(2, '0')}:00`}
                </div>
                <div className="text-[11px] text-gray-500 dark:text-gray-400 space-y-0.5">
                  <div>{compactNumber(slot.visibleCount)} {t('dashboard.requests')}</div>
                  <div>{compactNumber(slot.tokens)} {t('dashboard.tokens')}</div>
                  {slot.errorCount > 0 && (
                    <div className="text-red-400">
                      {slot.errorCount} {t('common.errors')} ({(errorRate * 100).toFixed(1)}%)
                    </div>
                  )}
                </div>
                {mode === 'requests' && slot.models.length > 0 && (
                  <div className="border-t border-gray-200 dark:border-gray-700 mt-1 pt-1 space-y-0.5">
                    {slot.models.slice(0, 6).map((m) => {
                      const color = colorMap.get(m.model) ?? MUTED_COLOR;
                      return (
                        <div key={m.model} className="flex items-center gap-1 text-[11px]">
                          <span className={`w-1.5 h-1.5 rounded-full ${color.dot}`} />
                          <span className="truncate max-w-[140px]">{m.model}</span>
                          <span className="ml-auto text-gray-400">{m.count}</span>
                        </div>
                      );
                    })}
                    {slot.models.length > 6 && (
                      <div className="text-[10px] text-gray-400">+{slot.models.length - 6} more</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 시간 라벨 */}
      <div className="flex gap-px mt-1 border-t border-gray-200 dark:border-gray-800 pt-1">
        {slots.map((slot, idx) => {
          const showLabel = idx % labelInterval === 0;
          const isNewDay = idx > 0 && slot.localDate.getDate() !== slots[idx - 1].localDate.getDate();
          return (
            <div key={idx} className="flex-1 text-center min-w-0 overflow-hidden">
              {isNewDay && showDateLabels ? (
                <span className="text-[9px] text-gray-400 dark:text-gray-500">
                  {slot.localDate.getMonth() + 1}/{slot.localDate.getDate()}
                </span>
              ) : showLabel ? (
                <span className="text-[10px] text-gray-400 dark:text-gray-600">
                  {String(slot.localHour).padStart(2, '0')}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* 모델 레전드 (요청 모드에서만) */}
      {mode === 'requests' && allModels.length > 0 && (
        <div className="mt-3 pt-2 border-t border-gray-200 dark:border-gray-800/50">
          <div className="flex flex-wrap items-center gap-1.5">
            {allModels.length > 1 && (
              <button
                onClick={showAll}
                className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                  allVisible
                    ? 'text-gray-400 dark:text-gray-600'
                    : 'text-blue-500 dark:text-blue-400 hover:text-blue-400 dark:hover:text-blue-300'
                }`}
              >
                {t('common.all')}
              </button>
            )}
            {legendModels.map((model) => {
              const color = colorMap.get(model) ?? MUTED_COLOR;
              const visible = !hiddenModels.has(model);
              return (
                <button
                  key={model}
                  onClick={() => toggleModel(model)}
                  className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                    visible
                      ? 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                      : 'text-gray-300 dark:text-gray-700 line-through hover:text-gray-400 dark:hover:text-gray-500'
                  }`}
                  title={`${model}: ${modelCounts.get(model)} ${t('dashboard.requests')}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${visible ? color.dot : 'bg-gray-300 dark:bg-gray-700'}`} />
                  <span className="max-w-[120px] truncate">{model}</span>
                  <span className="text-gray-400 dark:text-gray-600 tabular-nums">{compactNumber(modelCounts.get(model) ?? 0)}</span>
                </button>
              );
            })}
            {allModels.length > TOP_LEGEND_LIMIT && (
              <button
                onClick={() => setLegendExpanded((v) => !v)}
                className="text-[10px] px-1.5 py-0.5 rounded text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 transition-colors"
              >
                {legendExpanded
                  ? t('dashboard.showLess')
                  : t('dashboard.showMoreCount', { count: allModels.length - TOP_LEGEND_LIMIT })}
              </button>
            )}
          </div>
          {mode === 'requests' && totalErrors > 0 && (
            <div className="flex items-center gap-1 mt-1.5 text-[10px] text-gray-400 dark:text-gray-500">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500/80" />
              <span>{t('dashboard.errorOverlay')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ModeChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
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

