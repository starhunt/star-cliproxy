import { useEffect, useState, useCallback } from 'react';
import {
  fetchDebugConfig,
  updateDebugConfig,
  fetchDebugLogs,
  clearDebugLogs,
  fetchModelMappings,
  type DebugConfig,
  type DebugLog,
} from '../api/client';

export default function DebugPage() {
  const [config, setConfig] = useState<DebugConfig | null>(null);
  const [logs, setLogs] = useState<DebugLog[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [filterModel, setFilterModel] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadConfig = useCallback(() => {
    fetchDebugConfig().then(setConfig).catch((e) => setError(e.message));
  }, []);

  const loadLogs = useCallback(() => {
    fetchDebugLogs({ limit: 100, model: filterModel || undefined })
      .then((res) => setLogs(res.data))
      .catch((e) => setError(e.message));
  }, [filterModel]);

  useEffect(() => {
    loadConfig();
    loadLogs();
    fetchModelMappings()
      .then((mappings) => {
        const aliases = [...new Set(mappings.map((m) => m.alias))];
        setModels(aliases);
      })
      .catch(() => {});
  }, [loadConfig, loadLogs]);

  const toggleGlobal = async () => {
    if (!config) return;
    try {
      const updated = await updateDebugConfig({ global: !config.global });
      setConfig(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const toggleModel = async (alias: string) => {
    if (!config) return;
    try {
      const updated = await updateDebugConfig({ model: alias, enabled: !config.models[alias] });
      setConfig(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleClear = async () => {
    if (!confirm('Clear all debug logs?')) return;
    try {
      await clearDebugLogs();
      setLogs([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleRefresh = () => {
    loadLogs();
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Debug</h2>

      {error && (
        <div className="flex items-center justify-between bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2">
          <p className="text-red-400 text-sm">{error}</p>
          <button onClick={() => setError(null)} className="text-red-400/60 hover:text-red-400 text-xs">dismiss</button>
        </div>
      )}

      {/* Debug Config */}
      {config && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-4">
          <h3 className="text-sm font-semibold text-gray-300">Debug Capture</h3>

          {/* Global Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Global</p>
              <p className="text-xs text-gray-500">Capture all API requests/responses</p>
            </div>
            <ToggleSwitch enabled={config.global} onToggle={toggleGlobal} />
          </div>

          {/* Per-Model Toggles */}
          {models.length > 0 && (
            <div className="border-t border-gray-800 pt-3 space-y-2">
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Per Model</p>
              <div className="flex flex-wrap gap-2">
                {models.map((alias) => {
                  const active = config.global || !!config.models[alias];
                  return (
                    <button
                      key={alias}
                      onClick={() => toggleModel(alias)}
                      disabled={config.global}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-mono border transition-colors ${
                        config.global
                          ? 'opacity-50 cursor-not-allowed border-green-500/30 bg-green-500/10 text-green-400'
                          : active
                            ? 'border-green-500/50 bg-green-500/15 text-green-400 hover:bg-green-500/25'
                            : 'border-gray-700 bg-gray-800 text-gray-500 hover:border-gray-600 hover:text-gray-400'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-green-400' : 'bg-gray-600'}`} />
                      {alias}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Logs Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-semibold">Debug Logs</h3>
          <span className="text-xs text-gray-500">{logs.length} entries</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={filterModel}
            onChange={(e) => setFilterModel(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300"
          >
            <option value="">All Models</option>
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <button
            onClick={handleRefresh}
            className="px-3 py-1 bg-gray-800 hover:bg-gray-700 rounded text-xs transition-colors"
          >
            Refresh
          </button>
          <button
            onClick={handleClear}
            className="px-3 py-1 bg-red-900/50 hover:bg-red-800/50 text-red-400 rounded text-xs transition-colors"
          >
            Clear All
          </button>
        </div>
      </div>

      {/* Logs List */}
      <div className="space-y-2">
        {logs.map((log) => (
          <DebugLogEntry
            key={log.id}
            log={log}
            expanded={expandedId === log.id}
            onToggle={() => setExpandedId(expandedId === log.id ? null : log.id)}
          />
        ))}
        {logs.length === 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-8 text-center text-gray-600">
            {config?.global || Object.keys(config?.models ?? {}).length > 0
              ? 'No debug logs yet. Make an API request to capture data.'
              : 'Debug is disabled. Enable it above to start capturing.'}
          </div>
        )}
      </div>
    </div>
  );
}

function DebugLogEntry({
  log,
  expanded,
  onToggle,
}: {
  log: DebugLog;
  expanded: boolean;
  onToggle: () => void;
}) {
  const statusColor = log.status === 'pending'
    ? 'text-blue-400 animate-pulse'
    : log.status === 'success'
      ? 'text-green-400'
      : log.status === 'timeout'
        ? 'text-yellow-400'
        : 'text-red-400';

  const time = formatTime(log.createdAt);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      {/* Summary Row */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-800/50 transition-colors"
      >
        <span className={`text-xs font-mono font-bold ${statusColor}`}>
          {log.status.toUpperCase()}
        </span>
        <span className="text-sm font-mono text-blue-400">{log.modelAlias}</span>
        <span className="text-xs text-gray-600">→</span>
        <span className="text-xs font-mono text-gray-500">{log.provider}:{log.actualModel}</span>
        <span className="text-xs text-gray-600 ml-auto">
          {log.isStream ? 'stream' : 'sync'}
        </span>
        <span className="text-xs text-gray-500">{log.latencyMs}ms</span>
        <span className="text-xs text-gray-600">{time}</span>
        <svg
          className={`w-4 h-4 text-gray-600 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Detail Panel */}
      {expanded && (
        <div className="border-t border-gray-800 p-4 space-y-4">
          {/* CLI Args */}
          {log.cliArgs && (
            <DetailSection title="CLI Command">
              <code className="text-green-300">
                {(() => {
                  try {
                    const args = JSON.parse(log.cliArgs) as string[];
                    return args.map((a) => (a.includes(' ') ? `'${a}'` : a)).join(' ');
                  } catch { return log.cliArgs; }
                })()}
              </code>
            </DetailSection>
          )}

          {/* Request Messages */}
          {log.requestMessages && (
            <DetailSection title="Request Messages">
              <pre className="text-yellow-200 whitespace-pre-wrap break-all">
                {formatJson(log.requestMessages)}
              </pre>
            </DetailSection>
          )}

          {/* Raw Output */}
          {log.rawStdout && (
            <DetailSection title="Raw stdout">
              <pre className="text-gray-300 whitespace-pre-wrap break-all">{log.rawStdout}</pre>
            </DetailSection>
          )}

          {log.rawStderr && (
            <DetailSection title="Raw stderr">
              <pre className="text-red-300 whitespace-pre-wrap break-all">{log.rawStderr}</pre>
            </DetailSection>
          )}

          {/* Parsed Content */}
          {log.parsedContent && (
            <DetailSection title="Parsed Response">
              <pre className="text-blue-200 whitespace-pre-wrap break-words">{log.parsedContent}</pre>
            </DetailSection>
          )}

          {/* Token Usage */}
          {log.tokenUsage && (
            <DetailSection title="Token Usage">
              <code className="text-cyan-300">{formatJson(log.tokenUsage)}</code>
            </DetailSection>
          )}

          {/* Error */}
          {log.errorMessage && (
            <DetailSection title="Error">
              <pre className="text-red-400">{log.errorMessage}</pre>
            </DetailSection>
          )}

          <div className="text-xs text-gray-600 font-mono">
            Request ID: {log.requestId}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{title}</p>
      <div className="bg-gray-950 rounded px-3 py-2 text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

function ToggleSwitch({
  enabled,
  onToggle,
  disabled,
}: {
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        disabled ? 'opacity-50 cursor-not-allowed' : ''
      } ${enabled ? 'bg-green-500' : 'bg-gray-600'}`}
      title={disabled ? 'Controlled by global toggle' : enabled ? 'Click to disable' : 'Click to enable'}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          enabled ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

function formatTime(dateStr: string): string {
  const normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleTimeString();
}

function formatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}
