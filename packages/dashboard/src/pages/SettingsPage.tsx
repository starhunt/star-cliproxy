import { useEffect, useState } from 'react';
import { fetchValidationSettings, updateValidationSettings, type ValidationSettings } from '../api/client';

interface FieldDef {
  key: keyof ValidationSettings;
  label: string;
  description: string;
  format: 'chars' | 'bytes';
}

const FIELDS: FieldDef[] = [
  { key: 'maxMessageCount', label: 'Max Message Count', description: 'Maximum number of messages per request', format: 'chars' },
  { key: 'maxMessageLength', label: 'Max Message Length', description: 'Maximum characters per individual message', format: 'chars' },
  { key: 'maxPromptLength', label: 'Max Prompt Length', description: 'Maximum total characters across all messages', format: 'chars' },
  { key: 'maxResponseLength', label: 'Max Response Length', description: 'Maximum characters in CLI response', format: 'chars' },
  { key: 'bodyLimitBytes', label: 'Body Size Limit', description: 'Maximum HTTP request body size', format: 'bytes' },
];

function formatValue(value: number, format: 'chars' | 'bytes'): string {
  if (format === 'bytes') {
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(0)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
    return `${value} B`;
  }
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<ValidationSettings | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetchValidationSettings()
      .then((s) => {
        setSettings(s);
        setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, String(s[f.key])])));
      })
      .catch((e) => setError(e.message));
  }, []);

  const handleSave = async () => {
    if (!settings) return;
    try {
      const updates: Partial<ValidationSettings> = {};
      for (const field of FIELDS) {
        const val = parseInt(draft[field.key], 10);
        if (!isNaN(val) && val !== settings[field.key]) {
          (updates as Record<string, number>)[field.key] = val;
        }
      }
      if (Object.keys(updates).length === 0) return;

      const updated = await updateValidationSettings(updates);
      setSettings(updated);
      setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, String(updated[f.key])])));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  };

  const hasChanges = settings && FIELDS.some((f) => {
    const val = parseInt(draft[f.key], 10);
    return !isNaN(val) && val !== settings[f.key];
  });

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Settings</h2>

      {error && (
        <div className="flex items-center justify-between bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2">
          <p className="text-red-400 text-sm">{error}</p>
          <button onClick={() => setError(null)} className="text-red-400/60 hover:text-red-400 text-xs">dismiss</button>
        </div>
      )}

      {/* Validation Settings */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-300">Validation Limits</h3>
            <p className="text-xs text-gray-600 mt-0.5">Changes apply immediately without restart</p>
          </div>
          <div className="flex items-center gap-2">
            {saved && <span className="text-xs text-green-400">Saved!</span>}
            <button
              onClick={handleSave}
              disabled={!hasChanges}
              className={`px-4 py-1.5 rounded text-sm transition-colors ${
                hasChanges
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : 'bg-gray-800 text-gray-600 cursor-not-allowed'
              }`}
            >
              Save
            </button>
          </div>
        </div>

        {settings ? (
          <div className="space-y-4">
            {FIELDS.map((field) => (
              <div key={field.key} className="grid grid-cols-12 gap-4 items-center">
                <div className="col-span-5">
                  <label className="text-sm text-gray-300">{field.label}</label>
                  <p className="text-xs text-gray-600">{field.description}</p>
                </div>
                <div className="col-span-4">
                  <input
                    type="number"
                    value={draft[field.key] ?? ''}
                    onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm font-mono text-gray-300 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div className="col-span-3 text-right">
                  <span className="text-xs text-gray-500 font-mono">
                    {formatValue(parseInt(draft[field.key], 10) || 0, field.format)}
                  </span>
                  {parseInt(draft[field.key], 10) !== settings[field.key] && (
                    <span className="text-xs text-yellow-400 ml-2">modified</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="h-32 flex items-center justify-center text-gray-600 text-sm">Loading...</div>
        )}
      </div>
    </div>
  );
}
