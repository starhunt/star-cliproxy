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

// OpenAI messages → Claude CLI용 stdin 프롬프트 (convertMessages 미러링)
function rebuildClaudeStdin(messages: Array<{ role: string; content: string }>): string {
  const nonSystem = messages.filter((m) => m.role !== 'system');
  if (nonSystem.length === 1 && nonSystem[0].role === 'user') {
    return nonSystem[0].content;
  }
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg.role === 'user') parts.push(`<|user|> ${msg.content}`);
    else if (msg.role === 'assistant') parts.push(`<|assistant|> ${msg.content}`);
  }
  return parts.join('\n\n');
}

// OpenAI messages → Gemini/Codex용 단일 프롬프트 (convertMessagesToSinglePrompt 미러링)
function rebuildSinglePrompt(messages: Array<{ role: string; content: string }>): string {
  const nonSystem = messages.filter((m) => m.role !== 'system');
  const systemMsg = messages.find((m) => m.role === 'system');

  let userPrompt: string;
  if (nonSystem.length === 1 && nonSystem[0].role === 'user') {
    userPrompt = nonSystem[0].content;
  } else {
    const parts: string[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') continue;
      if (msg.role === 'user') parts.push(`<|user|> ${msg.content}`);
      else if (msg.role === 'assistant') parts.push(`<|assistant|> ${msg.content}`);
    }
    userPrompt = parts.join('\n\n');
  }

  if (systemMsg) {
    return `<|system|> ${systemMsg.content}\n\n${userPrompt}`;
  }
  return userPrompt;
}

// 셸 인자 이스케이프
function escapeShellArg(a: string): string {
  if (a.includes("'")) return `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`;
  if (a.includes(' ') || a.includes('"') || a.includes('\\') || a.includes('$') || a.includes('`')) return `'${a}'`;
  return a;
}

// OS 감지
const isWindows = navigator.platform.startsWith('Win');

// stdin 파이프 명령 생성 (OS별 분기)
// macOS/Linux: printf 'text' | cmd
// Windows: echo text | cmd
function wrapWithStdinPipe(stdinData: string, cmd: string): string {
  if (isWindows) {
    // PowerShell/CMD: echo로 파이프, 줄바꿈 제거 (한 줄 명령)
    const escaped = stdinData
      .replace(/\n/g, ' ')
      .replace(/"/g, '\\"');
    return `echo "${escaped}" | ${cmd}`;
  }
  // macOS/Linux: printf로 줄바꿈 보존
  const escaped = stdinData
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "'\\''")
    .replace(/\n/g, '\\n');
  return `printf '${escaped}' | ${cmd}`;
}

// 디버그 로그에서 터미널에 한 줄로 붙여넣기 가능한 실행 명령 생성
function buildTerminalCommand(log: { cliArgs: string; provider: string; requestMessages?: string | null }): string {
  try {
    const args = JSON.parse(log.cliArgs) as string[];
    const provider = log.provider;

    // cliArgs 첫 번째가 CLI 바이너리인지 확인 (신규 로그는 포함, 기존 로그는 미포함)
    const firstIsFlag = args[0]?.startsWith('-');
    const cmdArgs = firstIsFlag ? [provider, ...args] : args;

    let messages: Array<{ role: string; content: string }> | null = null;
    if (log.requestMessages) {
      try { messages = JSON.parse(log.requestMessages); } catch { /* ignore */ }
    }

    if (provider === 'claude') {
      const cmd = cmdArgs.map(escapeShellArg).join(' ');
      if (messages) {
        return wrapWithStdinPipe(rebuildClaudeStdin(messages), cmd);
      }
      return cmd;
    }

    if (provider === 'gemini') {
      const cmd = cmdArgs.map(escapeShellArg).join(' ');
      if (messages) {
        return wrapWithStdinPipe(rebuildSinglePrompt(messages), cmd);
      }
      return cmd;
    }

    if (provider === 'codex') {
      // Codex: stdin으로 프롬프트 전달 (- 플래그)
      const cmd = cmdArgs.map(escapeShellArg).join(' ');
      if (messages) {
        return wrapWithStdinPipe(rebuildSinglePrompt(messages), cmd);
      }
      return cmd;
    }

    // 기타 프로바이더
    const cmd = cmdArgs.map(escapeShellArg).join(' ');
    if (messages) {
      return wrapWithStdinPipe(rebuildSinglePrompt(messages), cmd);
    }
    return cmd;
  } catch {
    return log.cliArgs;
  }
}

// ms를 가독성 좋은 단위로 변환
function formatLatency(ms: number | null): string {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

// cliArgs JSON에서 session= 값 추출
function extractSessionFromArgs(cliArgs: string | null): { sessionId: string | null; reused: boolean } {
  if (!cliArgs) return { sessionId: null, reused: false };
  try {
    const args = JSON.parse(cliArgs) as string[];
    let sessionId: string | null = null;
    let reused = false;
    for (const arg of args) {
      if (arg.startsWith('session=')) sessionId = arg.slice(8);
      if (arg === 'reused=true') reused = true;
    }
    return { sessionId: sessionId === 'none' ? null : sessionId, reused };
  } catch {
    return { sessionId: null, reused: false };
  }
}

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
  const [sessionModalId, setSessionModalId] = useState<string | null>(null);
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
            onSessionClick={(sid) => setSessionModalId(sid)}
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
        <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
      )}

      {/* 세션 히스토리 모달 */}
      {sessionModalId && (
        <SessionModal
          sessionId={sessionModalId}
          logs={logs}
          onClose={() => setSessionModalId(null)}
        />
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
  onSessionClick,
}: {
  log: DebugLog;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onSelect: () => void;
  onSessionClick: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopyCommand = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!log.cliArgs) return;
    const command = buildTerminalCommand({
      cliArgs: log.cliArgs,
      provider: log.provider,
      requestMessages: log.requestMessages,
    });
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const statusColor = log.status === 'pending'
    ? 'text-blue-500 dark:text-blue-400 animate-pulse'
    : log.status === 'success'
      ? 'text-green-500 dark:text-green-400'
      : log.status === 'timeout'
        ? 'text-yellow-500 dark:text-yellow-400'
        : 'text-red-500 dark:text-red-400';

  const time = formatTime(log.createdAt);
  const payload = calcPayloadSizes(log);

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
        {/* 세션 배지 (SDK 모드) */}
        {(() => {
          const { sessionId, reused } = extractSessionFromArgs(log.cliArgs);
          if (!sessionId) return null;
          return (
            <button
              onClick={(e) => { e.stopPropagation(); onSessionClick(sessionId); }}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${
                reused
                  ? 'bg-purple-100 dark:bg-purple-500/15 text-purple-600 dark:text-purple-400 hover:bg-purple-200 dark:hover:bg-purple-500/25'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
              title={`Session: ${sessionId}`}
            >
              <span className={`w-1 h-1 rounded-full ${reused ? 'bg-purple-500' : 'bg-gray-400'}`} />
              {sessionId.slice(0, 8)}
            </button>
          );
        })()}
        <span className="text-xs text-gray-400 dark:text-gray-600 ml-auto">
          {log.isStream ? 'stream' : 'sync'}
        </span>
        <span className="text-xs text-gray-400 dark:text-gray-500">{formatLatency(log.latencyMs)}</span>
        <span className="text-xs font-mono text-gray-400 dark:text-gray-600" title="Request → Response payload size">
          <span className="text-orange-400 dark:text-orange-500">↑{payload.req}</span>
          <span className="mx-0.5">/</span>
          <span className="text-teal-400 dark:text-teal-500">↓{payload.res}</span>
        </span>
        <span className="text-xs text-gray-400 dark:text-gray-600">{time}</span>
        {log.cliArgs && (
          <button
            onClick={handleCopyCommand}
            className={`transition-colors ${copied ? 'text-green-500 dark:text-green-400' : 'text-gray-300 dark:text-gray-700 hover:text-blue-500 dark:hover:text-blue-400'}`}
            title={copied ? t('debug.copied') : t('debug.copyCommand')}
          >
            {copied ? (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>
        )}
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

// 세션 히스토리 모달: 동일 세션 ID를 가진 로그를 시간순으로 표시
function SessionModal({ sessionId, logs, onClose }: {
  sessionId: string;
  logs: DebugLog[];
  onClose: () => void;
}) {
  const { t } = useTranslation();

  // 현재 페이지 로그에서 동일 세션 필터
  const sessionLogs = logs
    .filter((log) => {
      const { sessionId: sid } = extractSessionFromArgs(log.cliArgs);
      return sid === sessionId;
    })
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const statusColor = (status: string) =>
    status === 'success'
      ? 'text-green-500 dark:text-green-400'
      : status === 'pending'
        ? 'text-blue-500 dark:text-blue-400'
        : status === 'timeout'
          ? 'text-yellow-500 dark:text-yellow-400'
          : 'text-red-500 dark:text-red-400';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-800">
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('debug.sessionHistory')}
            </h3>
            <p className="text-[10px] font-mono text-purple-600 dark:text-purple-400 mt-0.5">
              {sessionId}
            </p>
            <p className="text-[10px] text-gray-400 dark:text-gray-600 mt-0.5">
              {t('debug.sessionRequests').replace('{count}', String(sessionLogs.length))}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 로그 목록 */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {sessionLogs.length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-gray-600 text-center py-8">
              현재 페이지에 이 세션의 로그가 없습니다.
            </p>
          ) : (
            sessionLogs.map((log, idx) => {
              const { reused } = extractSessionFromArgs(log.cliArgs);
              return (
                <div key={log.id} className="flex items-start gap-3 group">
                  {/* 타임라인 */}
                  <div className="flex flex-col items-center pt-1">
                    <span className={`w-2.5 h-2.5 rounded-full border-2 ${
                      log.status === 'success'
                        ? 'border-green-500 bg-green-100 dark:bg-green-500/20'
                        : log.status === 'pending'
                          ? 'border-blue-500 bg-blue-100 dark:bg-blue-500/20 animate-pulse'
                          : 'border-red-500 bg-red-100 dark:bg-red-500/20'
                    }`} />
                    {idx < sessionLogs.length - 1 && (
                      <div className="w-px flex-1 bg-gray-200 dark:bg-gray-700 mt-1" />
                    )}
                  </div>
                  {/* 내용 */}
                  <div className="flex-1 pb-3">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-bold font-mono ${statusColor(log.status)}`}>
                        {log.status.toUpperCase()}
                      </span>
                      <span className="text-xs font-mono text-blue-600 dark:text-blue-400">
                        {log.modelAlias}
                      </span>
                      <span className="text-[10px] text-gray-400 dark:text-gray-600">
                        {log.isStream ? 'stream' : 'sync'}
                      </span>
                      <span className={`text-[10px] px-1 py-0.5 rounded ${
                        reused
                          ? 'bg-purple-100 dark:bg-purple-500/15 text-purple-600 dark:text-purple-400'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
                      }`}>
                        {reused ? t('debug.sessionReused') : t('debug.sessionNew')}
                      </span>
                      <span className="text-[10px] text-gray-400 dark:text-gray-500 ml-auto">
                        {formatLatency(log.latencyMs)}
                      </span>
                      <span className="text-[10px] text-gray-400 dark:text-gray-600">
                        {formatTime(log.createdAt)}
                      </span>
                    </div>
                    {log.parsedContent && (
                      <p className="text-[11px] text-gray-600 dark:text-gray-400 mt-1 line-clamp-2 leading-relaxed">
                        {log.parsedContent.slice(0, 200)}{log.parsedContent.length > 200 ? '...' : ''}
                      </p>
                    )}
                    {log.tokenUsage && (() => {
                      try {
                        const u = JSON.parse(log.tokenUsage);
                        return (
                          <p className="text-[10px] text-gray-400 dark:text-gray-600 mt-0.5">
                            {u.promptTokens} in / {u.completionTokens} out
                          </p>
                        );
                      } catch { return null; }
                    })()}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* 푸터 */}
        <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 rounded-lg text-xs text-gray-700 dark:text-gray-300 transition-colors"
          >
            {t('debug.closeModal')}
          </button>
        </div>
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

// 바이트 수를 사람이 읽기 쉬운 단위로 변환
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// LLM 요청/응답 페이로드 크기 계산
function calcPayloadSizes(log: DebugLog): { req: string; res: string } {
  const reqBytes = log.requestMessages?.length ?? 0;
  // rawStdout = LLM 원본 응답, parsedContent = 파싱된 내용 (rawStdout 우선)
  const resBytes = log.rawStdout?.length ?? log.parsedContent?.length ?? 0;
  return { req: formatBytes(reqBytes), res: formatBytes(resBytes) };
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
  sections.push(`Latency    : ${formatLatency(log.latencyMs)} (${log.latencyMs}ms)`);
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

// 페이지 번호 목록 생성 (현재 페이지 주변 + 처음/끝)
function getPageNumbers(current: number, total: number): (number | '...')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);

  const pages: (number | '...')[] = [];
  // 항상 첫 페이지
  pages.push(0);

  const start = Math.max(1, current - 1);
  const end = Math.min(total - 2, current + 1);

  if (start > 1) pages.push('...');
  for (let i = start; i <= end; i++) pages.push(i);
  if (end < total - 2) pages.push('...');

  // 항상 마지막 페이지
  pages.push(total - 1);
  return pages;
}

function Pagination({ currentPage, totalPages, onPageChange }: {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  const btnBase = 'px-2.5 py-1 rounded text-xs transition-colors';
  const btnNav = `${btnBase} bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 disabled:opacity-40 disabled:pointer-events-none`;
  const btnPage = (active: boolean) =>
    active
      ? `${btnBase} bg-blue-600 text-white`
      : `${btnBase} bg-gray-100 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300`;

  const pages = getPageNumbers(currentPage, totalPages);

  return (
    <div className="flex items-center justify-center gap-1">
      <button onClick={() => onPageChange(0)} disabled={currentPage === 0} className={btnNav}>«</button>
      <button onClick={() => onPageChange(currentPage - 1)} disabled={currentPage === 0} className={btnNav}>‹</button>
      {pages.map((p, i) =>
        p === '...' ? (
          <span key={`ellipsis-${i}`} className="px-1.5 text-xs text-gray-400 dark:text-gray-600">…</span>
        ) : (
          <button key={p} onClick={() => onPageChange(p)} className={btnPage(p === currentPage)}>
            {p + 1}
          </button>
        ),
      )}
      <button onClick={() => onPageChange(currentPage + 1)} disabled={currentPage >= totalPages - 1} className={btnNav}>›</button>
      <button onClick={() => onPageChange(totalPages - 1)} disabled={currentPage >= totalPages - 1} className={btnNav}>»</button>
    </div>
  );
}
