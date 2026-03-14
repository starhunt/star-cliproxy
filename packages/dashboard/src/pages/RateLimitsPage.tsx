import { useEffect, useState } from 'react';
import { fetchRateLimits, updateRateLimits, type RateLimitsConfig } from '../api/client';

const PROVIDERS = ['claude', 'codex', 'gemini'] as const;

export default function RateLimitsPage() {
  const [config, setConfig] = useState<RateLimitsConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = () => {
    fetchRateLimits()
      .then(setConfig)
      .catch((e) => setMessage({ type: 'error', text: e.message }));
  };

  useEffect(load, []);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setMessage(null);
    try {
      const result = await updateRateLimits(config);
      setConfig(result.config);
      setMessage({ type: 'success', text: 'Rate limits updated and applied immediately.' });
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Failed to save' });
    } finally {
      setSaving(false);
    }
  };

  if (!config) {
    return <div className="text-gray-500">Loading...</div>;
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
      <h2 className="text-2xl font-bold">Rate Limits</h2>
      <p className="text-sm text-gray-400">
        변경 사항은 저장 즉시 반영됩니다. 서버 재시작 없이 적용됩니다.
      </p>

      {/* Message */}
      {message && (
        <div className={`px-4 py-3 rounded-lg border text-sm ${
          message.type === 'success'
            ? 'bg-green-500/10 border-green-500/30 text-green-400'
            : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
          {message.text}
        </div>
      )}

      {/* Global Limits */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Global Limits</h3>
        <p className="text-xs text-gray-500">모든 요청에 적용되는 전체 한도입니다.</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-gray-400 block mb-1.5">Requests per Minute (RPM)</label>
            <input
              type="number"
              min="1"
              value={config.global.rpm}
              onChange={(e) => updateGlobal('rpm', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1.5">Requests per Day (RPD)</label>
            <input
              type="number"
              min="1"
              value={config.global.rpd}
              onChange={(e) => updateGlobal('rpd', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
            />
          </div>
        </div>
      </div>

      {/* Per-Provider Limits */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Per-Provider Limits</h3>
        <p className="text-xs text-gray-500">각 CLI provider별 분당 요청 한도입니다.</p>
        <div className="space-y-3">
          {PROVIDERS.map((provider) => (
            <div key={provider} className="flex items-center gap-4">
              <span className="w-20 text-sm text-gray-400 capitalize">{provider}</span>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="1"
                    value={config.perProvider[provider]?.rpm ?? 20}
                    onChange={(e) => updateProvider(provider, e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
                  />
                  <span className="text-xs text-gray-600 whitespace-nowrap">RPM</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Per-Key Info */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-2">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Per-Key Limits</h3>
        <p className="text-xs text-gray-500">
          개별 API 키에 대한 Rate Limit은 <a href="/keys" className="text-blue-400 underline hover:text-blue-300">API Keys</a> 페이지에서 키별로 설정할 수 있습니다.
          설정하지 않으면 위의 Global 한도가 적용됩니다.
        </p>
      </div>

      {/* Limit Hierarchy */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Limit Hierarchy</h3>
        <div className="text-sm text-gray-400 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-gray-600">1.</span> Global RPM/RPD
            <span className="text-gray-600">—</span>
            <span className="text-gray-500">전체 요청에 적용</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-600">2.</span> Provider RPM
            <span className="text-gray-600">—</span>
            <span className="text-gray-500">각 CLI provider별 적용</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-600">3.</span> API Key RPM/RPD
            <span className="text-gray-600">—</span>
            <span className="text-gray-500">개별 키에 설정된 경우 적용</span>
          </div>
        </div>
        <p className="text-xs text-gray-600">요청은 3단계 모두를 통과해야 합니다. 하나라도 초과하면 429 에러가 반환됩니다.</p>
      </div>

      {/* Save */}
      <div className="flex gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-lg text-sm font-medium transition-colors"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
        <button
          onClick={load}
          disabled={saving}
          className="px-4 py-2.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm transition-colors"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
