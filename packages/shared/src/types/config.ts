// 설정 파일 타입 정의

import type { ProviderName } from './provider.js';

export interface ServerConfig {
  port: number;
  host: string;
  cors: {
    origins: string[];
  };
}

export interface DashboardConfig {
  port: number;
  host: string;
}

export interface DatabaseConfig {
  path: string;
}

export interface AuthConfig {
  enabled: boolean;
  adminToken: string;
  initialKeys: Array<{
    name: string;
    key: string;
  }>;
}

export interface ProviderConfigYaml {
  enabled: boolean;
  cli_path: string;
  default_model: string;
  max_concurrent: number;
  timeout_ms: number;
  extra_args: string[];
}

export interface RateLimitConfig {
  global: {
    rpm: number;
    rpd: number;
  };
  perProvider: Partial<Record<ProviderName, { rpm: number }>>;
}

export interface CacheConfig {
  enabled: boolean;
  ttlSeconds: number;
  maxEntries: number;
}

export interface ModelMappingSeed {
  alias: string;
  provider: ProviderName;
  actual_model: string;
}

export interface ValidationConfig {
  maxMessageCount: number;       // 메시지 배열 최대 수 (기본 200)
  maxMessageLength: number;      // 개별 메시지 content 최대 길이 (기본 100000)
  maxPromptLength: number;       // 전체 프롬프트 총 길이 (기본 500000)
  maxResponseLength: number;     // CLI 응답 최대 길이 (기본 500000)
  bodyLimitBytes: number;        // HTTP 요청 본문 최대 크기 (기본 10MB)
}

export interface AppConfig {
  server: ServerConfig;
  dashboard: DashboardConfig;
  database: DatabaseConfig;
  auth: AuthConfig;
  providers: Record<ProviderName, ProviderConfigYaml>;
  rateLimits: RateLimitConfig;
  cache: CacheConfig;
  validation: ValidationConfig;
  modelMappings: ModelMappingSeed[];
}
