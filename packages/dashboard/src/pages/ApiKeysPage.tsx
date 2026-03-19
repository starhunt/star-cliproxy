import { useEffect, useState } from 'react';
import { fetchApiKeys, createApiKey, updateApiKey, deleteApiKey, regenerateApiKey, type ApiKey } from '../api/client';

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);

  const handleCopyFullKey = () => {
    if (!createdKey) return;
    navigator.clipboard.writeText(createdKey).then(() => {
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 1500);
    });
  };

  const load = () => {
    fetchApiKeys().then(setKeys).catch((e) => setError(e.message));
  };

  useEffect(load, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const result = await createApiKey({ name: newKeyName });
      setCreatedKey(result.key);
      setKeyCopied(false);
      setNewKeyName('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  const handleRegenerate = async (key: ApiKey) => {
    if (!confirm(`Regenerate key "${key.name}"? The old key will stop working immediately.`)) return;
    try {
      const result = await regenerateApiKey(key.id);
      setCreatedKey(result.key);
      setKeyCopied(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Regenerate failed');
    }
  };

  const handleToggle = async (key: ApiKey) => {
    try {
      await updateApiKey(key.id, { enabled: !key.enabled });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Toggle failed');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this API key? This cannot be undone.')) return;
    try {
      await deleteApiKey(id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">API Keys</h2>
        <button
          onClick={() => { setShowForm(!showForm); setCreatedKey(null); }}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm transition-colors"
        >
          + Generate Key
        </button>
      </div>

      {error && (
        <div className="flex items-center justify-between bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2">
          <p className="text-red-400 text-sm">{error}</p>
          <button onClick={() => setError(null)} className="text-red-400/60 hover:text-red-400 text-xs">dismiss</button>
        </div>
      )}

      {/* Created Key Display */}
      {createdKey && (
        <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-5 h-5 text-yellow-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <p className="text-yellow-300 text-sm font-semibold">Copy and save this key now. It cannot be viewed again after closing.</p>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-gray-900 px-4 py-2 rounded font-mono text-sm text-green-300 select-all overflow-x-auto">
              {createdKey}
            </code>
            <button
              onClick={handleCopyFullKey}
              className="flex-shrink-0 px-3 py-2 bg-green-600 hover:bg-green-700 rounded text-sm font-medium transition-colors"
            >
              {keyCopied ? 'Copied!' : 'Copy Key'}
            </button>
          </div>
        </div>
      )}

      {/* Create Form */}
      {showForm && !createdKey && (
        <form onSubmit={handleCreate} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex gap-3 items-end">
          <div className="flex-1">
            <label className="text-xs text-gray-400 block mb-1">Key Name</label>
            <input
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              placeholder="my-app"
              required
            />
          </div>
          <button type="submit" className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm">
            Generate
          </button>
        </form>
      )}

      {/* Keys Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wider">
              <th className="text-left px-4 py-3">Name</th>
              <th className="text-left px-4 py-3">Key Prefix</th>
              <th className="text-left px-4 py-3">Rate Limit</th>
              <th className="text-left px-4 py-3">Last Used</th>
              <th className="text-center px-4 py-3">Enabled</th>
              <th className="text-right px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                <td className="px-4 py-3 font-medium">{k.name}</td>
                <td className="px-4 py-3 font-mono text-gray-400">
                  {k.keyPrefix}...
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {k.rateLimitRpm ? `${k.rateLimitRpm} RPM` : 'Global'}
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {k.lastUsedAt ? formatKeyDate(k.lastUsedAt) : 'Never'}
                </td>
                <td className="px-4 py-3 text-center">
                  <ToggleSwitch enabled={k.enabled} onToggle={() => handleToggle(k)} />
                </td>
                <td className="px-4 py-3 text-right">
                  <span className="inline-flex items-center gap-1">
                    <button
                      onClick={() => handleRegenerate(k)}
                      className="text-gray-600 hover:text-yellow-400 transition-colors"
                      title="Regenerate key"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDelete(k.id)}
                      className="text-gray-600 hover:text-red-400 transition-colors"
                      title="Delete key"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </span>
                </td>
              </tr>
            ))}
            {keys.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-600">No API keys</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ToggleSwitch({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${enabled ? 'bg-green-500' : 'bg-gray-600'}`}
      title={enabled ? 'Click to disable' : 'Click to enable'}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`}
      />
    </button>
  );
}

function formatKeyDate(dateStr: string): string {
  if (!dateStr || dateStr.includes('datetime')) return '-';
  const normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString();
}
