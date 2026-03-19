// Provider 추상화 타입 정의

import type { ChatMessage } from './api.js';

export type ProviderName = 'claude' | 'codex' | 'gemini';

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
