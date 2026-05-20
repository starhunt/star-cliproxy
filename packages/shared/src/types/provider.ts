// Provider 추상화 타입 정의

import type { ChatMessage } from './api.js';

// 빌트인 프로바이더 (메인 코드에 포함)
export const BUILTIN_PROVIDERS = ['claude', 'codex', 'copilot', 'gemini', 'agy'] as const;
export type BuiltinProviderName = typeof BUILTIN_PROVIDERS[number];

// 플러그인 프로바이더까지 포함하는 동적 타입
export type ProviderName = string;

// 프로바이더가 지원하는 엔드포인트 타입
// 'rerank'는 HTTP 프로바이더 전용 (CLI/플러그인 프로바이더는 지원하지 않음).
export type EndpointType = 'chat' | 'images' | 'tts' | 'embeddings' | 'rerank';

// 플러그인 설정 (ProviderConfigYaml과 동일 구조, 순환 참조 방지용)
export interface PluginProviderConfig {
  enabled: boolean;
  cli_path: string;
  default_model: string;
  max_concurrent: number;
  timeout_ms: number;
  extra_args: string[];
  [key: string]: unknown;  // 플러그인 고유 설정 허용
}

// 플러그인 인터페이스 — 커스텀 프로바이더가 구현해야 하는 계약
export interface CliproxyPlugin {
  name: string;
  endpointTypes: EndpointType[];
  createProvider(config: PluginProviderConfig): CliproxyPluginProvider;
  createParser?(): StreamParser;
}

// 플러그인 프로바이더 인터페이스 (BaseProvider 의존성 제거용)
export interface CliproxyPluginProvider {
  readonly name: string;
  readonly endpointTypes?: EndpointType[];
  execute(options: ExecuteOptions): Promise<ExecuteResult>;
  /** @deprecated ProviderEvent 기반 AsyncIterable 권장 */
  executeStream?(options: ExecuteOptions): AsyncIterable<StreamChunk | ProviderEvent>;
  checkHealth(): Promise<HealthStatus>;
}

// StreamParser 인터페이스 (shared에서 정의하여 플러그인이 참조 가능)
export interface StreamParser {
  /** @deprecated parseEvents() 사용 권장 */
  parse(line: string): StreamChunk | null;
  /** 한 줄의 CLI 출력을 0개 이상의 ProviderEvent로 변환 */
  parseEvents?(line: string): ProviderEvent[];
}

export interface ProviderConfig {
  name: ProviderName;
  enabled: boolean;
  cliPath: string;
  defaultModel: string;
  maxConcurrent: number;
  timeoutMs: number;
  extraArgs: string[];
}

export interface DebugCaptureInfo {
  cliArgs: string[];
  stdout?: string;
  stderr?: string;
  streamLines?: string[];

  // HTTP Provider 전용
  httpRequest?: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
  httpResponse?: {
    status: number;
    headers: Record<string, string>;
    body?: unknown;
  };
  httpStreamLines?: string[];

  // 파싱 이전의 raw 응답 텍스트
  rawResponseText?: string;
}

// CLI 추론 수준 — Claude(--effort), Codex(model_reasoning_effort), Copilot(--effort) 공통.
// codex는 'xhigh'/'max'를 지원하지 않으므로 codex provider에서 'high'로 폴백한다.
// Gemini는 지원하지 않으므로 무시된다.
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const REASONING_EFFORT_VALUES: readonly ReasoningEffort[] = [
  'low', 'medium', 'high', 'xhigh', 'max',
] as const;

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string'
    && (REASONING_EFFORT_VALUES as readonly string[]).includes(value);
}

export interface ExecuteOptions {
  messages: ChatMessage[];
  model: string;
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onDebug?: (info: DebugCaptureInfo) => void;
  clientKey?: string;  // 세션 재사용용 클라이언트 식별자 (API key ID 또는 X-Cliproxy-Session-Id 헤더)
  // 모델 매핑에서 지정한 CLI 추론 수준 (provider별 옵션으로 변환)
  reasoningEffort?: ReasoningEffort;
  // 모델 매핑에서 지정한 provider 옵션 오버라이드 (화이트리스트 기반 deep merge)
  providerOverrides?: import('./config.js').ProviderOverrides;
  // 백엔드 비표준 필드 패스스루 (HTTP provider 전용). chat_template_kwargs/think/top_k 등.
  // CLI provider는 무시.
  extraBody?: Record<string, unknown>;
  // Image generation passthrough (OpenAI Images API)
  responseFormat?: 'url' | 'b64_json';
  n?: number;
  size?: string;
}

// Provider 실행 결과 메타데이터 (codex CLI thread_id 등)
export interface ExecuteMeta {
  threadId?: string;       // codex CLI: thread.started에서 추출한 UUID
  threadReused?: boolean;  // resume args로 호출되었는지 여부
}

// 임베딩 전용 옵션/결과
export interface EmbeddingOptions {
  model: string;
  input: string | string[];
  encodingFormat?: 'float' | 'base64';
  dimensions?: number;
  signal?: AbortSignal;
  providerOverrides?: import('./config.js').ProviderOverrides;
  onDebug?: (info: DebugCaptureInfo) => void;
}

export interface EmbeddingResult {
  embeddings: number[][];
  model: string;
  usage: {
    promptTokens: number;
    totalTokens: number;
  };
}

// 리랭킹 전용 옵션/결과 (Cohere Rerank API 호환 시맨틱).
// HTTP 프로바이더 전용 — CLI/플러그인 프로바이더는 미지원.
export interface RerankOptions {
  model: string;
  query: string;
  documents: string[];
  topN?: number;
  returnDocuments?: boolean;
  signal?: AbortSignal;
  providerOverrides?: import('./config.js').ProviderOverrides;
  onDebug?: (info: DebugCaptureInfo) => void;
}

export interface RerankResultItem {
  index: number;
  relevanceScore: number;
  document?: string;
}

export interface RerankResult {
  results: RerankResultItem[];
  model: string;
  usage: {
    totalTokens: number;
  };
}

// TTS 전용 옵션/결과
export interface TtsOptions {
  model: string;
  input: string;
  voice: string;
  responseFormat?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  speed?: number;
  signal?: AbortSignal;
  onDebug?: (info: DebugCaptureInfo) => void;
}

export interface TtsResult {
  audio: Buffer;
  contentType: string;
}

// 토큰 사용량 (공통 타입)
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ExecuteResult {
  content: string;
  /** 추론 모델의 thinking/CoT 본문. content와 분리되어 보존됨 (있을 때만). */
  reasoning?: string;
  usage: TokenUsage;
  finishReason: 'stop' | 'length' | 'error';
  meta?: ExecuteMeta;  // provider별 부가 메타데이터 (codex thread_id 등)
}

// --- ProviderEvent: discriminated union 기반 스트리밍 이벤트 ---

export interface ProviderTextDeltaEvent {
  type: 'text_delta';
  text: string;
}

export interface ProviderToolUseEvent {
  type: 'tool_use';
  toolCallId: string;
  toolName: string;
  input: string;        // JSON string (완전한 인자 또는 스트리밍 delta)
  isPartial?: boolean;  // true = 스트리밍 JSON delta
}

export interface ProviderThinkingEvent {
  type: 'thinking';
  text: string;
}

export interface ProviderUsageEvent {
  type: 'usage';
  usage: TokenUsage;
}

export interface ProviderErrorEvent {
  type: 'error';
  error: string;
  code?: string;
}

export interface ProviderDoneEvent {
  type: 'done';
  finishReason?: 'stop' | 'length' | 'tool_use' | 'error';
}

// codex CLI thread.started 이벤트 — provider 내부에서 SessionManager 갱신용으로 가로챔.
// HTTP 라우트 SSE 변환기는 default 분기로 무시 (외부 노출 없음 — 응답 헤더로만 노출).
export interface ProviderThreadStartedEvent {
  type: 'thread_started';
  threadId: string;
}

export type ProviderEvent =
  | ProviderTextDeltaEvent
  | ProviderToolUseEvent
  | ProviderThinkingEvent
  | ProviderUsageEvent
  | ProviderErrorEvent
  | ProviderDoneEvent
  | ProviderThreadStartedEvent;

/** @deprecated ProviderEvent 사용 권장 */
export interface StreamChunk {
  type: 'delta' | 'done' | 'error';
  content?: string;
  error?: string;
  usage?: TokenUsage;
}

// --- StreamChunk ↔ ProviderEvent 어댑터 ---

/** StreamChunk를 ProviderEvent[]로 변환 (레거시 파서 호환) */
export function streamChunkToEvents(chunk: StreamChunk): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  switch (chunk.type) {
    case 'delta':
      if (chunk.content) events.push({ type: 'text_delta', text: chunk.content });
      break;
    case 'error':
      events.push({ type: 'error', error: chunk.error ?? 'Unknown error' });
      break;
    case 'done':
      if (chunk.usage) events.push({ type: 'usage', usage: chunk.usage });
      events.push({ type: 'done' });
      break;
  }
  return events;
}

/** ProviderEvent를 StreamChunk로 변환 (레거시 소비자 호환, lossy) */
export function eventToStreamChunk(event: ProviderEvent): StreamChunk | null {
  switch (event.type) {
    case 'text_delta':     return { type: 'delta', content: event.text };
    case 'thinking':       return { type: 'delta', content: event.text };
    case 'error':          return { type: 'error', error: event.error };
    case 'done':           return { type: 'done' };
    case 'tool_use':       return null;
    case 'usage':          return null;
    case 'thread_started': return null;  // 내부 이벤트, 외부 SSE 변환 대상 아님
    default:               return null;
  }
}

export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

// Generic CLI 프로바이더 설정 (대시보드에서 커스텀 프로바이더 등록용)
// ProviderConfigYaml과 동일 구조로 확장 (순환 참조 방지: config.ts가 provider.ts를 이미 import함)
export interface GenericCliProviderConfig extends PluginProviderConfig {
  // 프롬프트 전달 방식
  prompt_mode: 'stdin' | 'arg';
  prompt_arg_template?: string;  // arg 모드: e.g. ["--", "{prompt}"]

  // CLI 인자 템플릿 - 플레이스홀더: {model}, {prompt}
  args_template: string[];   // e.g. ["-m", "{model}", "--format", "json"]

  // 출력 파싱
  output_mode: 'plain_text' | 'json_field';
  output_json_content_field?: string;   // json_field 모드: "result", "response", etc.

  // 스트리밍
  streaming_enabled: boolean;
  stream_args_template?: string[];
  stream_content_field?: string;   // ndjson content field
  stream_done_indicator?: string;  // e.g. "[DONE]"

  // 헬스 체크
  health_check_args?: string[];   // default: ["--version"]

  // 메타
  display_name: string;
  description?: string;
}

// HTTP Provider 설정 (OpenAI 호환 API용)
export interface HttpProviderConfig {
  enabled: boolean;
  base_url: string;           // e.g. "http://localhost:8080"
  api_key?: string;           // Authorization: Bearer {api_key}
  custom_headers?: Record<string, string>;
  default_model: string;
  default_max_tokens?: number; // 클라이언트 미지정 시 기본 max_tokens (기본: 65536)
  max_concurrent: number;
  timeout_ms: number;

  // 메타
  display_name: string;
  description?: string;
}

export interface ProviderHealthInfo {
  provider: ProviderName;
  status: HealthStatus;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  errorMessage: string | null;
}
