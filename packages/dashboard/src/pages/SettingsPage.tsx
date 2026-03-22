import { useEffect, useState, useRef } from 'react';
import { useTranslation } from '../i18n/context';
import {
  fetchValidationSettings, updateValidationSettings, type ValidationSettings,
  fetchExport, importConfig, type ExportData, type ImportResult,
} from '../api/client';

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

type FieldKey = keyof ValidationSettings;

interface FieldDef {
  key: FieldKey;
  labelKey: string;
  descKey: string;
  format: 'chars' | 'bytes';
}

const FIELDS: FieldDef[] = [
  { key: 'maxMessageCount', labelKey: 'settings.maxMessageCount', descKey: 'settings.maxMessageCountDesc', format: 'chars' },
  { key: 'maxMessageLength', labelKey: 'settings.maxMessageLength', descKey: 'settings.maxMessageLengthDesc', format: 'chars' },
  { key: 'maxPromptLength', labelKey: 'settings.maxPromptLength', descKey: 'settings.maxPromptLengthDesc', format: 'chars' },
  { key: 'maxResponseLength', labelKey: 'settings.maxResponseLength', descKey: 'settings.maxResponseLengthDesc', format: 'chars' },
  { key: 'bodyLimitBytes', labelKey: 'settings.bodyLimitBytes', descKey: 'settings.bodyLimitBytesDesc', format: 'bytes' },
];

export default function SettingsPage() {
  const { t } = useTranslation();
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

  // Export/Import 상태
  const [exporting, setExporting] = useState(false);
  const [importPreview, setImportPreview] = useState<ExportData | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    setExporting(true);
    setError(null);
    try {
      const data = await fetchExport();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const date = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `cliproxy-config-${date}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target?.result as string) as ExportData;
        if (!data.version || data.version !== 1) {
          setError(t('settings.invalidFile'));
          return;
        }
        setImportPreview(data);
        setImportResult(null);
        setError(null);
      } catch {
        setError(t('settings.invalidFile'));
      }
    };
    reader.readAsText(file);
    // input 초기화 (같은 파일 재선택 가능)
    e.target.value = '';
  };

  const handleImport = async () => {
    if (!importPreview) return;
    if (!confirm(t('settings.importConfirm'))) return;

    setImporting(true);
    setError(null);
    try {
      const result = await importConfig(importPreview);
      setImportResult(result);
      setImportPreview(null);
      // validation 설정이 변경되었을 수 있으므로 다시 로드
      const s = await fetchValidationSettings();
      setSettings(s);
      setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, String(s[f.key])])));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('settings.title')}</h2>

      {error && (
        <div className="flex items-center justify-between bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg px-4 py-2">
          <p className="text-red-500 dark:text-red-400 text-sm">{error}</p>
          <button onClick={() => setError(null)} className="text-red-400/60 hover:text-red-400 text-xs">{t('common.dismiss')}</button>
        </div>
      )}

      {/* 유효성 검사 설정 */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{t('settings.validationLimits')}</h3>
            <p className="text-xs text-gray-400 dark:text-gray-600 mt-0.5">{t('settings.validationDescription')}</p>
          </div>
          <div className="flex items-center gap-2">
            {saved && <span className="text-xs text-green-500 dark:text-green-400">{t('common.saved')}</span>}
            <button
              onClick={handleSave}
              disabled={!hasChanges}
              className={`px-4 py-1.5 rounded text-sm transition-colors ${
                hasChanges
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : 'bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed'
              }`}
            >
              {t('common.save')}
            </button>
          </div>
        </div>

        {settings ? (
          <div className="space-y-4">
            {FIELDS.map((field) => (
              <div key={field.key} className="grid grid-cols-12 gap-4 items-center">
                <div className="col-span-5">
                  <label className="text-sm text-gray-700 dark:text-gray-300">{t(field.labelKey)}</label>
                  <p className="text-xs text-gray-400 dark:text-gray-600">{t(field.descKey)}</p>
                </div>
                <div className="col-span-4">
                  <input
                    type="number"
                    value={draft[field.key] ?? ''}
                    onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
                    className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm font-mono text-gray-700 dark:text-gray-300 focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div className="col-span-3 text-right">
                  <span className="text-xs text-gray-400 dark:text-gray-500 font-mono">
                    {formatValue(parseInt(draft[field.key], 10) || 0, field.format)}
                  </span>
                  {parseInt(draft[field.key], 10) !== settings[field.key] && (
                    <span className="text-xs text-yellow-500 dark:text-yellow-400 ml-2">{t('common.modified')}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="h-32 flex items-center justify-center text-gray-400 dark:text-gray-600 text-sm">{t('common.loading')}</div>
        )}
      </div>

      {/* 데이터 관리 (Export/Import) */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5">
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{t('settings.dataManagement')}</h3>
          <p className="text-xs text-gray-400 dark:text-gray-600 mt-0.5">{t('settings.dataManagementDesc')}</p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleExport}
            disabled={exporting}
            className="px-4 py-1.5 rounded text-sm transition-colors bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
          >
            {exporting ? t('common.loading') : t('settings.export')}
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-4 py-1.5 rounded text-sm transition-colors bg-gray-200 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-700"
          >
            {t('settings.import')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>

        {/* Import 미리보기 */}
        {importPreview && (
          <div className="mt-4 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{t('settings.importSummary')}</h4>
            <ul className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
              <li>{t('settings.importModels').replace('{count}', String(importPreview.modelMappings?.length ?? 0))}</li>
              <li>{t('settings.importApiKeys').replace('{count}', String(importPreview.apiKeys?.length ?? 0))}</li>
              {(importPreview.apiKeys?.length ?? 0) > 0 && (
                <li className="text-yellow-600 dark:text-yellow-400">{t('settings.importApiKeysWarning')}</li>
              )}
              {importPreview.rateLimits && <li>{t('settings.importRateLimits')}</li>}
              {importPreview.validation && <li>{t('settings.importValidation')}</li>}
              {importPreview.providers && Object.keys(importPreview.providers).length > 0 && (
                <li className="text-gray-400 dark:text-gray-600">{t('settings.importProviders')}</li>
              )}
            </ul>
            <div className="flex items-center gap-2">
              <button
                onClick={handleImport}
                disabled={importing}
                className="px-4 py-1.5 rounded text-sm transition-colors bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
              >
                {importing ? t('common.loading') : t('settings.importConfirm').split('?')[0]}
              </button>
              <button
                onClick={() => setImportPreview(null)}
                className="px-4 py-1.5 rounded text-sm transition-colors bg-gray-200 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-700"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}

        {/* Import 결과 */}
        {importResult && (
          <div className="mt-4 border border-green-200 dark:border-green-500/30 bg-green-50 dark:bg-green-500/10 rounded-lg p-4 space-y-2">
            <h4 className="text-sm font-semibold text-green-700 dark:text-green-400">{t('settings.importSuccess')}</h4>
            <ul className="text-xs text-green-600 dark:text-green-400 space-y-1">
              <li>{t('settings.importModels').replace('{count}', String(importResult.imported.modelMappings))}</li>
              <li>
                API Keys: {t('settings.importCreated').replace('{count}', String(importResult.imported.apiKeys.created))},{' '}
                {t('settings.importUpdated').replace('{count}', String(importResult.imported.apiKeys.updated))}
              </li>
              {importResult.imported.rateLimits && <li>{t('settings.importRateLimits')}</li>}
              {importResult.imported.validation && <li>{t('settings.importValidation')}</li>}
            </ul>
            {importResult.skipped.length > 0 && (
              <p className="text-xs text-gray-400 dark:text-gray-600">
                Skipped: {importResult.skipped.join(', ')}
              </p>
            )}
            <button
              onClick={() => setImportResult(null)}
              className="text-xs text-green-500 hover:text-green-600 dark:hover:text-green-300"
            >
              {t('common.dismiss')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
