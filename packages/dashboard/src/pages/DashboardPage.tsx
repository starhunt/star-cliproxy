import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n/context';
import { fetchDashboard, type DashboardData } from '../api/client';

import { SummaryCards } from '../components/dashboard/SummaryCards';
import { ActiveRequests } from '../components/dashboard/ActiveRequests';
import { TrendChart } from '../components/dashboard/TrendChart';
import { SystemStatus } from '../components/dashboard/SystemStatus';
import { ProviderUsage } from '../components/dashboard/ProviderUsage';
import { PopularModels } from '../components/dashboard/PopularModels';
import { RecentRequests } from '../components/dashboard/RecentRequests';
import { RecentErrors } from '../components/dashboard/RecentErrors';

const PERIOD_OPTIONS = [
  { label: '1d', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All', days: 0 },
];

export default function DashboardPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [days, setDays] = useState(0);

  const load = () => {
    fetchDashboard(days || undefined)
      .then((d) => {
        setData(d);
        setLastUpdated(new Date());
        setError(null);
      })
      .catch((e) => setError(e.message));
  };

  useEffect(() => { load(); }, [days]);

  // 자동 리프레시: 활성 요청 유무에 따라 간격 조정
  const hasActiveRequests = (data?.activeRequests?.count ?? 0) > 0;
  useEffect(() => {
    const intervalMs = hasActiveRequests ? 2_000 : 10_000;
    const timer = setInterval(load, intervalMs);
    return () => clearInterval(timer);
  }, [hasActiveRequests, days]);

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-400 text-lg">{t('dashboard.connectionFailed')}</p>
        <p className="text-gray-400 dark:text-gray-500 mt-2">{t('dashboard.backendRunning')}</p>
        <button
          onClick={load}
          className="mt-4 px-4 py-2 bg-gray-200 dark:bg-gray-800 rounded text-sm hover:bg-gray-300 dark:hover:bg-gray-700"
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-gray-400 dark:text-gray-500 text-center py-20">
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 헤더 */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {t('dashboard.title')}
          </h2>
          <p className="text-sm text-gray-400 dark:text-gray-500 mt-0.5">
            {t('dashboard.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                onClick={() => setDays(opt.days)}
                className={`px-2 py-0.5 rounded text-xs transition-colors ${
                  days === opt.days
                    ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400'
                    : 'text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {lastUpdated && (
            <span className="text-xs text-gray-500 dark:text-gray-600">
              {t('dashboard.updated')} {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={load}
            className="px-3 py-1.5 bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 rounded text-xs text-gray-500 dark:text-gray-400"
          >
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {/* 요약 카드 */}
      <SummaryCards data={data} />

      {/* 활성 요청 (있을 때만) */}
      <ActiveRequests activeRequests={data.activeRequests} />

      {/* 추이 차트 + 시스템 상태 */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
          <TrendChart />
        </div>
        <div className="lg:col-span-2">
          <SystemStatus
            providers={data.providers}
            cache={data.cache}
            rateLimits={data.rateLimits}
            totalTokens={data.overview.totalTokens}
          />
        </div>
      </div>

      {/* 프로바이더 사용량 + 인기 모델 (전체 너비, 2단) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ProviderUsage providerStats={data.providerStats} />
        <PopularModels popularModels={data.popularModels} />
      </div>

      {/* 최근 요청 (전체 너비) */}
      <RecentRequests
        recentRequests={data.recentRequests}
        activeRequests={data.activeRequests}
      />

      {/* 최근 에러 (있을 때만) */}
      <RecentErrors recentErrors={data.recentErrors} />
    </div>
  );
}
