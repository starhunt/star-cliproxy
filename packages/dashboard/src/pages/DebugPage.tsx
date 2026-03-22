import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from '../i18n/context';
import {
  fetchDebugConfig,
  updateDebugConfig,
  fetchDebugLogs,
  deleteDebugLog,
  deleteDebugLogsBatch,
  clearDebugLogs,
  fetchModelMappings,
  type DebugConfig,
  type DebugLog,
} from '../api/client';

export default function DebugPage() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<DebugConfig | null>(null);
  const [logs, setLogs] = useState<DebugLog[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [filterModel, setFilterModel] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const PAGE_SIZE = 20;

  const loadConfig = useCallback(() => {
    fetchDebugConfig().then(setConfig).catch((e) => setError(e.message));
  }, []);

  const loadLogs = useCallback(() => {
    fetchDebugLogs({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, model: filterModel || undefined })
      .then((res) => {
        setLogs(res.data);
        setTotal(res.pagination.total);
      })
      .catch((e) => setError(e.message));
  }, [filterModel, page]);

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

  const handleDelete = async (id: string) => {
    try {
      await deleteDebugLog(id);
      setLogs((prev) => prev.filter((l) => l.id !== id));
      if (expandedId === id) setExpandedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleClear = async () => {
    if (!confirm(t('debug.confirmClear'))) return;
    try {
      await clearDebugLogs();
      setLogs([]);
      setTotal(0);
      setSelectedIds(new Set());
      setPage(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(t('debug.confirmDeleteSelected').replace('{count}', String(selectedIds.size)))) return;
    try {
      await deleteDebugLogsBatch([...selectedIds]);
      setSelectedIds(new Set());
      loadLogs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === logs.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(logs.map((l) => l.id)));
    }
  };

  const handleFilterChange = (model: string) => {
    setFilterModel(model);
    setPage(0);
    setSelectedIds(new Set());
  };

  const handleRefresh = () => {
    setSelectedIds(new Set());
    loadLogs();
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('debug.title')}</h2>

      {error && (
        <div className="flex items-center justify-between bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg px-4 py-2">
          <p className="text-red-500 dark:text-red-400 text-sm">{error}</p>
          <button onClick={() => setError(null)} className="text-red-400/60 hover:text-red-400 text-xs">{t('common.dismiss')}</button>
        </div>
      )}

      {/* 디버그 설정 */}
      {config && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 space-y-4">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{t('debug.debugCapture')}</h3>

          {/* 전역 토글 */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{t('debug.globalToggle')}</p>
              <p className="text-xs text-gray-400 dark:text-gray-500">{t('debug.globalDescription')}</p>
            </div>
            <ToggleSwitch enabled={config.global} onToggle={toggleGlobal} />
          </div>

          {/* 모델별 토글 */}
          {models.length > 0 && (
            <div className="border-t border-gray-200 dark:border-gray-800 pt-3 space-y-2">
              <p className="text-xs text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">{t('debug.perModel')}</p>
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
                          ? 'opacity-50 cursor-not-allowed border-green-300 dark:border-green-500/30 bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400'
                          : active
                            ? 'border-green-300 dark:border-green-500/50 bg-green-50 dark:bg-green-500/15 text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-500/25'
                            : 'border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 text-gray-500 hover:border-gray-400 dark:hover:border-gray-600 hover:text-gray-600 dark:hover:text-gray-400'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-green-500 dark:bg-green-400' : 'bg-gray-400 dark:bg-gray-600'}`} />
                      {alias}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 로그 헤더 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('debug.debugLogs')}</h3>
          <span className="text-xs text-gray-400 dark:text-gray-500">{total} {t('debug.entries')}</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={filterModel}
            onChange={(e) => handleFilterChange(e.target.value)}
            className="bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 text-xs text-gray-700 dark:text-gray-300"
          >
            <option value="">{t('debug.allModels')}</option>
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <button
            onClick={handleRefresh}
            className="px-3 py-1 bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 rounded text-xs transition-colors text-gray-600 dark:text-gray-300"
          >
            {t('common.refresh')}
          </button>
          {selectedIds.size > 0 && (
            <button
              onClick={handleDeleteSelected}
              className="px-3 py-1 bg-red-100 dark:bg-red-900/50 hover:bg-red-200 dark:hover:bg-red-800/50 text-red-600 dark:text-red-400 rounded text-xs transition-colors"
            >
              {t('debug.deleteSelected').replace('{count}', String(selectedIds.size))}
            </button>
          )}
          <button
            onClick={handleClear}
            className="px-3 py-1 bg-red-100 dark:bg-red-900/50 hover:bg-red-200 dark:hover:bg-red-800/50 text-red-600 dark:text-red-400 rounded text-xs transition-colors"
          >
            {t('common.clearAll')}
          </button>
        </div>
      </div>

      {/* 전체 선택 */}
      {logs.length > 0 && (
        <div className="flex items-center gap-2 px-1">
          <input
            type="checkbox"
            checked={selectedIds.size === logs.length && logs.length > 0}
            onChange={toggleSelectAll}
            className="w-3.5 h-3.5 rounded border-gray-300 dark:border-gray-600 accent-blue-500"
          />
          <span className="text-xs text-gray-400 dark:text-gray-500">{t('debug.selectAll')}</span>
        </div>
      )}

      {/* 로그 목록 */}
      <div className="space-y-2">
        {logs.map((log) => (
          <DebugLogEntry
            key={log.id}
            log={log}
            expanded={expandedId === log.id}
            selected={selectedIds.has(log.id)}
            onToggle={() => setExpandedId(expandedId === log.id ? null : log.id)}
            onDelete={() => handleDelete(log.id)}
            onSelect={() => toggleSelect(log.id)}
          />
        ))}
        {logs.length === 0 && (
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl px-4 py-8 text-center text-gray-400 dark:text-gray-600">
            {config?.global || Object.keys(config?.models ?? {}).length > 0
              ? t('debug.noLogs')
              : t('debug.disabled')}
          </div>
        )}
      </div>

      {/* 페이징 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="px-3 py-1 bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 rounded text-xs transition-colors text-gray-600 dark:text-gray-300 disabled:opacity-40"
          >
            {t('common.prev')}
          </button>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="px-3 py-1 bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 rounded text-xs transition-colors text-gray-600 dark:text-gray-300 disabled:opacity-40"
          >
            {t('common.next')}
          </button>
        </div>
      )}
    </div>
  );
}

function DebugLogEntry({
  log,
  expanded,
  selected,
  onToggle,
  onDelete,
  onSelect,
}: {
  log: DebugLog;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const statusColor = log.status === 'pending'
    ? 'text-blue-500 dark:text-blue-400 animate-pulse'
    : log.status === 'success'
      ? 'text-green-500 dark:text-green-400'
      : log.status === 'timeout'
        ? 'text-yellow-500 dark:text-yellow-400'
        : 'text-red-500 dark:text-red-400';

  const time = formatTime(log.createdAt);

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
      {/* 요약 행 */}
      <div className="w-full flex items-center gap-3 px-4 py-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => { e.stopPropagation(); onSelect(); }}
          className="w-3.5 h-3.5 rounded border-gray-300 dark:border-gray-600 accent-blue-500 shrink-0"
        />
        <button
          onClick={onToggle}
          className="flex-1 flex items-center gap-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors rounded -m-1 p-1"
        >
        <span className={`text-xs font-mono font-bold ${statusColor}`}>
          {log.status.toUpperCase()}
        </span>
        <span className="text-sm font-mono text-blue-600 dark:text-blue-400">{log.modelAlias}</span>
        <span className="text-xs text-gray-400 dark:text-gray-600">-&gt;</span>
        <span className="text-xs font-mono text-gray-500">{log.provider}:{log.actualModel}</span>
        <span className="text-xs text-gray-400 dark:text-gray-600 ml-auto">
          {log.isStream ? 'stream' : 'sync'}
        </span>
        <span className="text-xs text-gray-400 dark:text-gray-500">{log.latencyMs}ms</span>
        <span className="text-xs text-gray-400 dark:text-gray-600">{time}</span>
        <button
          onClick={(e) => { e.stopPropagation(); exportDebugLog(log); }}
          className="text-gray-300 dark:text-gray-700 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
          title="Export"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
          </svg>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="text-gray-300 dark:text-gray-700 hover:text-red-500 dark:hover:text-red-400 transition-colors"
          title="Delete"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <svg
          className={`w-4 h-4 text-gray-400 dark:text-gray-600 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
        </button>
      </div>

      {/* 상세 패널 */}
      {expanded && (
        <div className="border-t border-gray-200 dark:border-gray-800 p-4 space-y-4">
          {/* CLI 인자 */}
          {log.cliArgs && (
            <DetailSection title={t('debug.cliCommand')}>
              <pre className="text-green-600 dark:text-green-300 whitespace-pre-wrap break-all">
                {(() => {
                  try {
                    const args = JSON.parse(log.cliArgs) as string[];
                    return args.map((a) => (a.includes(' ') ? `'${a}'` : a)).join(' \\\n  ');
                  } catch { return log.cliArgs; }
                })()}
              </pre>
            </DetailSection>
          )}

          {/* 요청 메시지 */}
          {log.requestMessages && (
            <DetailSection title={t('debug.requestMessages')}>
              <pre className="text-yellow-600 dark:text-yellow-200 whitespace-pre-wrap break-all">
                {formatJson(log.requestMessages)}
              </pre>
            </DetailSection>
          )}

          {/* Raw 출력 */}
          {log.rawStdout && (
            <DetailSection title={t('debug.rawStdout')}>
              <pre className="text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-all">{formatNdjson(log.rawStdout)}</pre>
            </DetailSection>
          )}

          {log.rawStderr && (
            <DetailSection title={t('debug.rawStderr')}>
              <pre className="text-red-500 dark:text-red-300 whitespace-pre-wrap break-all">{log.rawStderr}</pre>
            </DetailSection>
          )}

          {/* 파싱된 콘텐츠 */}
          {log.parsedContent && (
            <DetailSection title={t('debug.parsedResponse')}>
              <pre className="text-blue-600 dark:text-blue-200 whitespace-pre-wrap break-words">{log.parsedContent}</pre>
              {isImageUrl(log.parsedContent) && (
                <div className="mt-2">
                  <img
                    src={log.parsedContent.trim()}
                    alt="Generated image"
                    className="max-w-md rounded-lg border border-gray-200 dark:border-gray-700"
                    loading="lazy"
                  />
                </div>
              )}
            </DetailSection>
          )}

          {/* 토큰 사용량 */}
          {log.tokenUsage && (
            <DetailSection title={t('debug.tokenUsage')}>
              <pre className="text-cyan-600 dark:text-cyan-300 whitespace-pre-wrap">{formatJson(log.tokenUsage)}</pre>
            </DetailSection>
          )}

          {/* 에러 */}
          {log.errorMessage && (
            <DetailSection title={t('debug.error')}>
              <pre className="text-red-500 dark:text-red-400">{log.errorMessage}</pre>
            </DetailSection>
          )}

          <div className="text-xs text-gray-400 dark:text-gray-600 font-mono">
            {t('debug.requestId')}: {log.requestId}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">{title}</p>
      <div className="bg-gray-50 dark:bg-gray-950 rounded px-3 py-2 text-xs font-mono overflow-x-auto max-h-96 overflow-y-auto">
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
      } ${enabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`}
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

// 개별 디버그 로그를 텍스트 파일로 내보내기
function exportDebugLog(log: DebugLog): void {
  const divider = '='.repeat(60);
  const sections: string[] = [];

  sections.push(`${divider}`);
  sections.push(`Debug Log Export`);
  sections.push(`${divider}`);
  sections.push(``);
  sections.push(`Request ID : ${log.requestId}`);
  sections.push(`Model      : ${log.modelAlias} -> ${log.provider}:${log.actualModel}`);
  sections.push(`Status     : ${log.status.toUpperCase()}`);
  sections.push(`Mode       : ${log.isStream ? 'stream' : 'sync'}`);
  sections.push(`Latency    : ${log.latencyMs}ms`);
  sections.push(`Time       : ${log.createdAt}`);
  if (log.errorMessage) {
    sections.push(`Error      : ${log.errorMessage}`);
  }

  if (log.cliArgs) {
    sections.push(``);
    sections.push(`${divider}`);
    sections.push(`CLI Command`);
    sections.push(`${divider}`);
    try {
      const args = JSON.parse(log.cliArgs) as string[];
      sections.push(args.map((a) => (a.includes(' ') ? `'${a}'` : a)).join(' \\\n  '));
    } catch {
      sections.push(log.cliArgs);
    }
  }

  if (log.requestMessages) {
    sections.push(``);
    sections.push(`${divider}`);
    sections.push(`Request Messages`);
    sections.push(`${divider}`);
    sections.push(formatJson(log.requestMessages));
  }

  if (log.rawStdout) {
    sections.push(``);
    sections.push(`${divider}`);
    sections.push(`Raw STDOUT`);
    sections.push(`${divider}`);
    sections.push(formatNdjson(log.rawStdout));
  }

  if (log.rawStderr) {
    sections.push(``);
    sections.push(`${divider}`);
    sections.push(`Raw STDERR`);
    sections.push(`${divider}`);
    sections.push(log.rawStderr);
  }

  if (log.parsedContent) {
    sections.push(``);
    sections.push(`${divider}`);
    sections.push(`Parsed Response`);
    sections.push(`${divider}`);
    sections.push(log.parsedContent);
  }

  if (log.tokenUsage) {
    sections.push(``);
    sections.push(`${divider}`);
    sections.push(`Token Usage`);
    sections.push(`${divider}`);
    sections.push(formatJson(log.tokenUsage));
  }

  const text = sections.join('\n');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `debug-${log.modelAlias}-${log.requestId}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function isImageUrl(text: string): boolean {
  const trimmed = text.trim();
  try {
    const url = new URL(trimmed);
    return /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(url.pathname)
      || url.hostname.includes('blob.core.windows.net');
  } catch {
    return false;
  }
}

// NDJSON (줄바꿈 구분 JSON) 포맷팅 — 각 줄을 개별 JSON으로 파싱 후 들여쓰기
function formatNdjson(str: string): string {
  const lines = str.split('\n').filter((l) => l.trim());
  const formatted = lines.map((line) => {
    try {
      const obj = JSON.parse(line);
      return JSON.stringify(obj, null, 2).replace(/\\n/g, '\n');
    } catch {
      return line;
    }
  });
  return formatted.join('\n\n---\n\n');
}

function formatJson(str: string): string {
  try {
    const parsed = JSON.parse(str);
    const formatted = JSON.stringify(parsed, null, 2);
    // 리터럴 \n을 실제 줄바꿈으로 변환
    return formatted.replace(/\\n/g, '\n');
  } catch {
    // JSON이 아니면 리터럴 \n만 변환
    return str.replace(/\\n/g, '\n');
  }
}
