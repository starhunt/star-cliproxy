import { useEffect, useState } from 'react';
import { fetchApiKeys, createApiKey, updateApiKey, deleteApiKey, type ApiKey } from '../api/client';

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    fetchApiKeys().then(setKeys).catch((e) => setError(e.message));
  };

  useEffect(load, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const result = await createApiKey({ name: newKeyName });
      setCreatedKey(result.key);
      setNewKeyName('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  const handleToggle = async (key: ApiKey) => {
    await updateApiKey(key.id, { enabled: !key.enabled });
    load();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Revoke this API key? This cannot be undone.')) return;
    await deleteApiKey(id);
    load();
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

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {/* Created Key Display */}
      {createdKey && (
        <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4">
          <p className="text-green-400 text-sm font-semibold mb-2">API Key Created - Save it now!</p>
          <code className="block bg-gray-900 px-4 py-2 rounded font-mono text-sm text-green-300 select-all">
            {createdKey}
          </code>
          <p className="text-xs text-gray-500 mt-2">This key will not be shown again.</p>
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
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-right px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                <td className="px-4 py-3 font-medium">{k.name}</td>
                <td className="px-4 py-3 font-mono text-gray-400">{k.keyPrefix}...</td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {k.rateLimitRpm ? `${k.rateLimitRpm} RPM` : 'Global'}
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {k.lastUsedAt ? formatKeyDate(k.lastUsedAt) : 'Never'}
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => handleToggle(k)}
                    className={`px-2 py-0.5 rounded text-xs ${k.enabled ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-500'}`}
                  >
                    {k.enabled ? 'Active' : 'Disabled'}
                  </button>
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button onClick={() => handleDelete(k.id)} className="px-2 py-0.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded text-xs transition-colors">
                    Revoke
                  </button>
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

function formatKeyDate(dateStr: string): string {
  if (!dateStr || dateStr.includes('datetime')) return '-';
  const normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString();
}
