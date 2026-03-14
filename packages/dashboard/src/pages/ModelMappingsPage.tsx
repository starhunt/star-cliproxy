import { useEffect, useState, useRef, useCallback } from 'react';
import {
  fetchModelMappings,
  createModelMapping,
  updateModelMapping,
  deleteModelMapping,
  testModel,
  type ModelMapping,
  type TestModelResult,
} from '../api/client';

export default function ModelMappingsPage() {
  const [mappings, setMappings] = useState<ModelMapping[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ alias: '', provider: 'claude', actual_model: '', priority: 0 });
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestModelResult | null>(null);
  const [rowTesting, setRowTesting] = useState<string | null>(null);
  const [rowTestResult, setRowTestResult] = useState<{ id: string; result: TestModelResult } | null>(null);

  // AbortController refs
  const formTestAbortRef = useRef<AbortController | null>(null);
  const rowTestAbortRef = useRef<AbortController | null>(null);

  const load = () => {
    fetchModelMappings().then(setMappings).catch((e) => setError(e.message));
  };

  useEffect(load, []);

  // 컴포넌트 언마운트 시 정리
  useEffect(() => {
    return () => {
      formTestAbortRef.current?.abort();
      rowTestAbortRef.current?.abort();
    };
  }, []);

  // 폼 테스트 취소
  const cancelFormTest = useCallback(() => {
    if (formTestAbortRef.current) {
      formTestAbortRef.current.abort();
      formTestAbortRef.current = null;
    }
    setTesting(false);
  }, []);

  // 행 테스트 취소
  const cancelRowTest = useCallback(() => {
    if (rowTestAbortRef.current) {
      rowTestAbortRef.current.abort();
      rowTestAbortRef.current = null;
    }
    setRowTesting(null);
  }, []);

  // 폼 닫기 (테스트 중이면 취소)
  const closeForm = useCallback(() => {
    cancelFormTest();
    setShowForm(false);
    setEditingId(null);
    setTestResult(null);
    setForm({ alias: '', provider: 'claude', actual_model: '', priority: 0 });
  }, [cancelFormTest]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    cancelFormTest();
    try {
      if (editingId) {
        await updateModelMapping(editingId, form);
      } else {
        await createModelMapping(form);
      }
      closeForm();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  };

  const handleEdit = (m: ModelMapping) => {
    cancelFormTest(); // 이전 테스트 취소
    setEditingId(m.id);
    setForm({ alias: m.alias, provider: m.provider, actual_model: m.actualModel, priority: m.priority });
    setShowForm(true);
    setTestResult(null);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this mapping?')) return;
    await deleteModelMapping(id);
    load();
  };

  const handleToggle = async (m: ModelMapping) => {
    await updateModelMapping(m.id, { enabled: !m.enabled });
    load();
  };

  // 폼에서 테스트
  const handleTest = async () => {
    if (!form.provider || !form.actual_model) {
      setTestResult({ success: false, provider: form.provider, model: form.actual_model, error: 'Provider and Actual Model are required.', latencyMs: 0 });
      return;
    }

    // 이전 테스트 취소
    cancelFormTest();

    const controller = new AbortController();
    formTestAbortRef.current = controller;

    setTesting(true);
    setTestResult(null);

    try {
      const result = await testModel(form.provider, form.actual_model, controller.signal);
      if (!controller.signal.aborted) {
        setTestResult(result);
      }
    } catch (err) {
      if (controller.signal.aborted) return; // 취소된 경우 무시
      setTestResult({ success: false, provider: form.provider, model: form.actual_model, error: err instanceof Error ? err.message : 'Test failed', latencyMs: 0 });
    } finally {
      if (!controller.signal.aborted) {
        setTesting(false);
      }
      if (formTestAbortRef.current === controller) {
        formTestAbortRef.current = null;
      }
    }
  };

  // 테이블 행에서 테스트
  const handleRowTest = async (m: ModelMapping) => {
    // 이전 행 테스트 취소
    cancelRowTest();

    const controller = new AbortController();
    rowTestAbortRef.current = controller;

    setRowTesting(m.id);
    setRowTestResult(null);

    try {
      const result = await testModel(m.provider, m.actualModel, controller.signal);
      if (!controller.signal.aborted) {
        setRowTestResult({ id: m.id, result });
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setRowTestResult({ id: m.id, result: { success: false, provider: m.provider, model: m.actualModel, error: err instanceof Error ? err.message : 'Test failed', latencyMs: 0 } });
    } finally {
      if (!controller.signal.aborted) {
        setRowTesting(null);
      }
      if (rowTestAbortRef.current === controller) {
        rowTestAbortRef.current = null;
      }
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Model Mappings</h2>
        <button
          onClick={() => {
            if (showForm) { closeForm(); }
            else {
              cancelFormTest();
              setShowForm(true);
              setEditingId(null);
              setForm({ alias: '', provider: 'claude', actual_model: '', priority: 0 });
              setTestResult(null);
            }
          }}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm transition-colors"
        >
          + Add Mapping
        </button>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {/* Form */}
      {showForm && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <form onSubmit={handleSubmit}>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="text-xs text-gray-400 block mb-1">Alias (client sends)</label>
                <input
                  value={form.alias}
                  onChange={(e) => setForm({ ...form, alias: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
                  placeholder="gpt-4"
                  required
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Provider</label>
                <select
                  value={form.provider}
                  onChange={(e) => { setForm({ ...form, provider: e.target.value }); setTestResult(null); }}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
                >
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                  <option value="gemini">Gemini</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Actual Model</label>
                <input
                  value={form.actual_model}
                  onChange={(e) => { setForm({ ...form, actual_model: e.target.value }); setTestResult(null); }}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
                  placeholder="claude-sonnet-4-6"
                  required
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Priority (lower = first)</label>
                <input
                  type="number"
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: parseInt(e.target.value) || 0 })}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              {testing ? (
                <button
                  type="button"
                  onClick={cancelFormTest}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded text-sm transition-colors"
                >
                  Cancel Test
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={!form.provider || !form.actual_model}
                  className="px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed rounded text-sm transition-colors"
                >
                  Test
                </button>
              )}
              <button type="submit" disabled={testing} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded text-sm">
                {editingId ? 'Update' : 'Create'}
              </button>
              <button type="button" onClick={closeForm} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm">
                Cancel
              </button>
            </div>
          </form>

          {/* Test Progress */}
          {testing && (
            <div className="mt-3 px-4 py-3 bg-gray-800/50 border border-gray-700 rounded-lg">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-gray-400">
                  <span className="inline-block w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                  Testing {form.provider} / {form.actual_model} ...
                </div>
                <button
                  onClick={cancelFormTest}
                  className="text-xs text-gray-500 hover:text-red-400 transition-colors"
                >
                  cancel
                </button>
              </div>
            </div>
          )}

          {/* Test Result */}
          {testResult && (
            <div className={`mt-3 px-4 py-3 rounded-lg border ${testResult.success ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
              <div className="flex items-center justify-between mb-1">
                <span className={`text-sm font-semibold ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
                  {testResult.success ? 'Test Passed' : 'Test Failed'}
                </span>
                <span className="text-xs text-gray-500">{testResult.latencyMs}ms</span>
              </div>
              {testResult.success && testResult.response && (
                <p className="text-sm text-gray-300 mt-1">
                  Response: <code className="bg-gray-800 px-1.5 py-0.5 rounded text-green-300">{testResult.response}</code>
                </p>
              )}
              {testResult.success && testResult.usage && (
                <p className="text-xs text-gray-500 mt-1">
                  Tokens: {testResult.usage.promptTokens} in / {testResult.usage.completionTokens} out
                </p>
              )}
              {!testResult.success && testResult.error && (
                <p className="text-sm text-red-300 mt-1">{testResult.error}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Row Test Result Banner */}
      {rowTesting && (
        <div className="px-4 py-3 bg-gray-800/50 border border-gray-700 rounded-lg">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <span className="inline-block w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
              Testing {mappings.find(m => m.id === rowTesting)?.provider} / {mappings.find(m => m.id === rowTesting)?.actualModel} ...
            </div>
            <button
              onClick={cancelRowTest}
              className="text-xs text-gray-500 hover:text-red-400 transition-colors"
            >
              cancel
            </button>
          </div>
        </div>
      )}
      {rowTestResult && (
        <div className={`px-4 py-3 rounded-lg border ${rowTestResult.result.success ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
          <div className="flex items-center justify-between">
            <div>
              <span className={`text-sm font-semibold ${rowTestResult.result.success ? 'text-green-400' : 'text-red-400'}`}>
                {rowTestResult.result.success ? 'Test Passed' : 'Test Failed'}
              </span>
              <span className="text-sm text-gray-400 ml-2">
                {rowTestResult.result.provider} / {rowTestResult.result.model}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500">{rowTestResult.result.latencyMs}ms</span>
              <button onClick={() => setRowTestResult(null)} className="text-gray-500 hover:text-gray-300 text-xs">dismiss</button>
            </div>
          </div>
          {rowTestResult.result.success && rowTestResult.result.response && (
            <p className="text-sm text-gray-300 mt-1">
              Response: <code className="bg-gray-800 px-1.5 py-0.5 rounded text-green-300">{rowTestResult.result.response}</code>
            </p>
          )}
          {!rowTestResult.result.success && rowTestResult.result.error && (
            <p className="text-sm text-red-300 mt-1">{rowTestResult.result.error}</p>
          )}
        </div>
      )}

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wider">
              <th className="text-left px-4 py-3">Alias</th>
              <th className="text-left px-4 py-3">Provider</th>
              <th className="text-left px-4 py-3">Actual Model</th>
              <th className="text-left px-4 py-3">Priority</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-right px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {mappings.map((m) => (
              <tr key={m.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                <td className="px-4 py-3 font-mono text-blue-400">{m.alias}</td>
                <td className="px-4 py-3 capitalize">{m.provider}</td>
                <td className="px-4 py-3 font-mono text-gray-300">{m.actualModel}</td>
                <td className="px-4 py-3 text-gray-500">{m.priority}</td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => handleToggle(m)}
                    className={`px-2 py-0.5 rounded text-xs ${m.enabled ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-500'}`}
                  >
                    {m.enabled ? 'ON' : 'OFF'}
                  </button>
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  {rowTesting === m.id ? (
                    <button
                      onClick={cancelRowTest}
                      className="text-red-400 hover:text-red-300 text-xs"
                    >
                      Cancel
                    </button>
                  ) : (
                    <button
                      onClick={() => handleRowTest(m)}
                      className="text-gray-400 hover:text-amber-400 text-xs"
                    >
                      Test
                    </button>
                  )}
                  <button onClick={() => handleEdit(m)} className="text-gray-400 hover:text-blue-400 text-xs">Edit</button>
                  <button onClick={() => handleDelete(m.id)} className="text-gray-400 hover:text-red-400 text-xs">Delete</button>
                </td>
              </tr>
            ))}
            {mappings.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-600">No model mappings configured</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
