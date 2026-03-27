import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n/context';
import { fetchRateLimits, updateRateLimits, fetchProviders, type RateLimitsConfig } from '../api/client';

export default function RateLimitsPage() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<RateLimitsConfig | null>(null);
  const [providerNames, setProviderNames] = useState<string[]>(['claude', 'codex', 'copilot', 'gemini']);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = () => {
    fetchRateLimits()
      .then(setConfig)
      .catch((e) => setMessage({ type: 'error', text: e.message }));
  };

  useEffect(load, []);

  // 프로바이더 목록 동적 로드 (플러그인 포함)
  useEffect(() => {
    fetchProviders()
      .then((providers) => setProviderNames(providers.map((p) => p.name)))
      .catch(() => { /* 실패 시 기본값 유지 */ });
  }, []);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setMessage(null);
    try {
      const result = await updateRateLimits(config);
      setConfig(result.config);
      setMessage({ type: 'success', text: t('rateLimits.description') });
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Failed to save' });
    } finally {
      setSaving(false);
    }
  };

  if (!config) {
    return <div className="text-gray-400 dark:text-gray-500">{t('common.loading')}</div>;
  }

  const updateGlobal = (field: 'rpm' | 'rpd', value: string) => {
    const num = parseInt(value) || 0;
    setConfig({ ...config, global: { ...config.global, [field]: num } });
    setMessage(null);
  };

  const updateProvider = (provider: string, value: string) => {
    const num = parseInt(value) || 0;
    setConfig({
      ...config,
      perProvider: {
        ...config.perProvider,
        [provider]: { rpm: num },
      },
    });
    setMessage(null);
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('rateLimits.title')}</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t('rateLimits.description')}
      </p>

      {/* 메시지 */}
      {message && (
        <div className={`px-4 py-3 rounded-lg border text-sm ${
          message.type === 'success'
            ? 'bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/30 text-green-600 dark:text-green-400'
            : 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-600 dark:text-red-400'
        }`}>
          {message.text}
        </div>
      )}

      {/* 전역 한도 */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">{t('rateLimits.globalLimits')}</h3>
        <p className="text-xs text-gray-400 dark:text-gray-500">{t('rateLimits.globalDescription')}</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1.5">{t('rateLimits.rpm')}</label>
            <input
              type="number"
              min="1"
              value={config.global.rpm}
              onChange={(e) => updateGlobal('rpm', e.target.value)}
              className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1.5">{t('rateLimits.rpd')}</label>
            <input
              type="number"
              min="1"
              value={config.global.rpd}
              onChange={(e) => updateGlobal('rpd', e.target.value)}
              className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
            />
          </div>
        </div>
      </div>

      {/* 프로바이더별 한도 */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">{t('rateLimits.perProvider')}</h3>
        <p className="text-xs text-gray-400 dark:text-gray-500">{t('rateLimits.perProviderDescription')}</p>
        <div className="space-y-3">
          {providerNames.map((provider) => (
            <div key={provider} className="flex items-center gap-4">
              <span className="w-20 text-sm text-gray-500 dark:text-gray-400 capitalize">{provider}</span>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="1"
                    value={config.perProvider[provider]?.rpm ?? 20}
                    onChange={(e) => updateProvider(provider, e.target.value)}
                    className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm text-gray-800 dark:text-gray-200"
                  />
                  <span className="text-xs text-gray-400 dark:text-gray-600 whitespace-nowrap">RPM</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 키별 안내 */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5 space-y-2">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">{t('rateLimits.perKey')}</h3>
        <p className="text-xs text-gray-400 dark:text-gray-500">
          {t('rateLimits.perKeyDescription', { link: '' }).split('{link}')[0]}
          <a href="/keys" className="text-blue-500 dark:text-blue-400 underline hover:text-blue-400 dark:hover:text-blue-300">{t('rateLimits.apiKeysLink')}</a>
          {t('rateLimits.perKeyDescription', { link: '' }).split('{link}')[1] ?? ''}
        </p>
      </div>

      {/* 한도 계층 */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5 space-y-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">{t('rateLimits.hierarchy')}</h3>
        <div className="text-sm text-gray-500 dark:text-gray-400 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-gray-400 dark:text-gray-600">1.</span> Global RPM/RPD
            <span className="text-gray-300 dark:text-gray-600">—</span>
            <span className="text-gray-400 dark:text-gray-500">{t('rateLimits.hierarchyGlobal')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-400 dark:text-gray-600">2.</span> Provider RPM
            <span className="text-gray-300 dark:text-gray-600">—</span>
            <span className="text-gray-400 dark:text-gray-500">{t('rateLimits.hierarchyProvider')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-400 dark:text-gray-600">3.</span> API Key RPM/RPD
            <span className="text-gray-300 dark:text-gray-600">—</span>
            <span className="text-gray-400 dark:text-gray-500">{t('rateLimits.hierarchyKey')}</span>
          </div>
        </div>
        <p className="text-xs text-gray-400 dark:text-gray-600">{t('rateLimits.hierarchyNote')}</p>
      </div>

      {/* 저장 */}
      <div className="flex gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-colors"
        >
          {saving ? t('common.saving') : t('rateLimits.saveChanges')}
        </button>
        <button
          onClick={load}
          disabled={saving}
          className="px-4 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded-lg text-sm text-gray-700 dark:text-gray-200 transition-colors"
        >
          {t('common.reset')}
        </button>
      </div>
    </div>
  );
}
