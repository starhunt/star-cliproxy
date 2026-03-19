const BASE_URL = '/admin';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...options?.headers as Record<string, string> };
  // body가 있을 때만 Content-Type 설정 (DELETE 등 빈 body 시 Fastify 400 방지)
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(error.error?.message ?? `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

// Dashboard (통합 데이터)
export interface DashboardData {
  overview: {
    totalRequests: number;
    successCount: number;
    errorCount: number;
    timeoutCount: number;
    successRate: number;
    avgLatencyMs: number;
    totalTokens: number;
    streamCount: number;
  };
  today: {
    count: number;
    successCount: number;
    avgLatencyMs: number;
  };
  apiKeys: { total: number; active: number };
  modelMappings: { total: number; active: number };
  providers: Array<{
    name: string;
    status: string;
    lastCheckAt: string | null;
    consecutiveFailures: number;
    queue: { pending: number; size: number; concurrency: number } | null;
  }>;
  cache: { totalEntries: number; activeEntries: number };
  rateLimits: { global: { rpm: number; rpd: number }; perProvider: Record<string, { rpm: number }> };
  providerStats: Array<{ provider: string; count: number; successCount: number; avgLatencyMs: number; totalTokens: number }>;
  popularModels: Array<{ modelAlias: string; provider: string; count: number; avgLatencyMs: number }>;
  hourlyTrend: Array<{ hour: number; count: number; successCount: number; errorCount: number }>;
  hourlyByModel: Array<{ hour: number; modelAlias: string; count: number }>;
  recentRequests: Array<{
    id: string;
    modelAlias: string;
    provider: string;
    actualModel: string;
    status: string;
    latencyMs: number;
    totalTokens: number | null;
    isStream: boolean;
    errorMessage: string | null;
    createdAt: string;
  }>;
  recentErrors: Array<{
    id: string;
    modelAlias: string;
    provider: string;
    status: string;
    errorMessage: string | null;
    latencyMs: number;
    createdAt: string;
  }>;
  activeRequests: {
    count: number;
    requests: Array<{
      requestId: string;
      modelAlias: string;
      provider: string;
      actualModel: string;
      isStream: boolean;
      startedAt: number;
      elapsedMs: number;
    }>;
  };
}

export function fetchDashboard() {
  return request<DashboardData>('/dashboard');
}

// Trend (시간대별 요청 추이)
export interface TrendData {
  hours: number;
  trend: Array<{ slot: string; count: number; successCount: number; errorCount: number }>;
  byModel: Array<{ slot: string; modelAlias: string; count: number }>;
}

export function fetchTrend(hours = 24) {
  return request<TrendData>(`/trend?hours=${hours}`);
}

// Stats
export function fetchStats() {
  return request<{
    overview: {
      totalRequests: number;
      successRate: string;
      avgLatencyMs: number;
      totalTokens: number;
    };
    byProvider: Array<{ provider: string; count: number; successCount: number; avgLatencyMs: number }>;
    byModel: Array<{ modelAlias: string; provider: string; count: number }>;
  }>('/stats');
}

// Logs
export function fetchLogs(params?: { limit?: number; offset?: number }) {
  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.offset) query.set('offset', String(params.offset));
  const qs = query.toString();
  return request<{
    data: Array<{
      id: string;
      requestId: string;
      modelAlias: string;
      provider: string;
      actualModel: string;
      status: string;
      latencyMs: number;
      ttfbMs: number | null;
      isStream: boolean;
      totalTokens: number | null;
      errorMessage: string | null;
      createdAt: string;
    }>;
    pagination: { limit: number; offset: number };
  }>(`/logs${qs ? `?${qs}` : ''}`);
}

// Model Mappings
export interface ModelMapping {
  id: string;
  alias: string;
  provider: string;
  actualModel: string;
  displayName: string | null;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export function fetchModelMappings() {
  return request<ModelMapping[]>('/model-mappings');
}

export function createModelMapping(data: {
  alias: string;
  provider: string;
  actual_model: string;
  display_name?: string;
  priority?: number;
}) {
  return request<ModelMapping>('/model-mappings', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateModelMapping(id: string, data: Partial<{
  alias: string;
  provider: string;
  actual_model: string;
  display_name: string;
  priority: number;
  enabled: boolean;
}>) {
  return request<ModelMapping>(`/model-mappings/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteModelMapping(id: string) {
  return request<void>(`/model-mappings/${id}`, { method: 'DELETE' });
}

// API Keys
export interface ApiKey {
  id: string;
  keyPrefix: string;
  name: string;
  enabled: boolean;
  rateLimitRpm: number | null;
  rateLimitRpd: number | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export function fetchApiKeys() {
  return request<ApiKey[]>('/api-keys');
}

export function createApiKey(data: { name: string; rate_limit_rpm?: number; rate_limit_rpd?: number }) {
  return request<{ id: string; key: string; key_prefix: string; name: string; message: string }>('/api-keys', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateApiKey(id: string, data: Partial<{ name: string; enabled: boolean; rate_limit_rpm: number | null; rate_limit_rpd: number | null }>) {
  return request<ApiKey>(`/api-keys/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function regenerateApiKey(id: string) {
  return request<{ id: string; key: string; key_prefix: string; name: string; message: string }>(`/api-keys/${id}/regenerate`, {
    method: 'POST',
  });
}

export function deleteApiKey(id: string) {
  return request<void>(`/api-keys/${id}`, { method: 'DELETE' });
}

// Providers
export interface ProviderInfo {
  name: string;
  status: string;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  queue: { pending: number; size: number; concurrency: number } | null;
}

export function fetchProviders() {
  return request<ProviderInfo[]>('/providers');
}

export function triggerHealthCheck(name: string) {
  return request<{ provider: string; status: string }>(`/providers/${name}/health-check`, {
    method: 'POST',
  });
}

// Test Model
export interface TestModelResult {
  success: boolean;
  provider: string;
  model: string;
  response?: string;
  error?: string;
  latencyMs: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export function testModel(provider: string, actual_model: string, signal?: AbortSignal) {
  return request<TestModelResult>('/test-model', {
    method: 'POST',
    body: JSON.stringify({ provider, actual_model }),
    signal,
  });
}

// Rate Limits
export interface RateLimitsConfig {
  global: { rpm: number; rpd: number };
  perProvider: Record<string, { rpm: number }>;
}

export function fetchRateLimits() {
  return request<RateLimitsConfig>('/rate-limits');
}

export function updateRateLimits(config: RateLimitsConfig) {
  return request<{ success: boolean; config: RateLimitsConfig }>('/rate-limits', {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

// Debug
export interface DebugConfig {
  global: boolean;
  models: Record<string, boolean>;
}

export interface DebugLog {
  id: string;
  requestId: string;
  modelAlias: string;
  provider: string;
  actualModel: string;
  isStream: boolean;
  cliArgs: string | null;
  requestMessages: string | null;
  rawStdout: string | null;
  rawStderr: string | null;
  parsedContent: string | null;
  tokenUsage: string | null;
  status: string;
  latencyMs: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export function fetchDebugConfig() {
  return request<DebugConfig>('/debug');
}

export function updateDebugConfig(data: { global?: boolean; model?: string; enabled?: boolean }) {
  return request<DebugConfig>('/debug', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function fetchDebugLogs(params?: { limit?: number; offset?: number; model?: string }) {
  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.offset) query.set('offset', String(params.offset));
  if (params?.model) query.set('model', String(params.model));
  const qs = query.toString();
  return request<{ data: DebugLog[]; pagination: { limit: number; offset: number } }>(
    `/debug-logs${qs ? `?${qs}` : ''}`,
  );
}

export function deleteDebugLog(id: string) {
  return request<{ success: boolean }>(`/debug-logs/${id}`, { method: 'DELETE' });
}

export function clearDebugLogs() {
  return request<{ deleted: number }>('/debug-logs', { method: 'DELETE' });
}

// Settings
export interface ValidationSettings {
  maxMessageCount: number;
  maxMessageLength: number;
  maxPromptLength: number;
  maxResponseLength: number;
  bodyLimitBytes: number;
}

export function fetchValidationSettings() {
  return request<ValidationSettings>('/settings/validation');
}

export function updateValidationSettings(data: Partial<ValidationSettings>) {
  return request<ValidationSettings>('/settings/validation', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}
