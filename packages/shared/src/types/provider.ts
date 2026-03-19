// Provider 추상화 타입 정의

import type { ChatMessage } from './api.js';

// 빌트인 프로바이더 (메인 코드에 포함)
export const BUILTIN_PROVIDERS = ['claude', 'codex', 'gemini'] as const;
export type BuiltinProviderName = typeof BUILTIN_PROVIDERS[number];

// 플러그인 프로바이더까지 포함하는 동적 타입
export type ProviderName = string;

// 프로바이더가 지원하는 엔드포인트 타입
export type EndpointType = 'chat' | 'images' | 'tts' | 'embeddings';

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
  executeStream?(options: ExecuteOptions): AsyncIterable<StreamChunk>;
  checkHealth(): Promise<HealthStatus>;
}

// StreamParser 인터페이스 (shared에서 정의하여 플러그인이 참조 가능)
export interface StreamParser {
  parse(line: string): StreamChunk | null;
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
}

export interface ExecuteOptions {
  messages: ChatMessage[];
  model: string;
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onDebug?: (info: DebugCaptureInfo) => void;
}

export interface ExecuteResult {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: 'stop' | 'length' | 'error';
}

export interface StreamChunk {
  type: 'delta' | 'done' | 'error';
  content?: string;
  error?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

export interface ProviderHealthInfo {
  provider: ProviderName;
  status: HealthStatus;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  errorMessage: string | null;
}
