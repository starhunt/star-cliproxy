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

export interface AppConfig {
  server: ServerConfig;
  dashboard: DashboardConfig;
  database: DatabaseConfig;
  auth: AuthConfig;
  providers: Record<ProviderName, ProviderConfigYaml>;
  rateLimits: RateLimitConfig;
  cache: CacheConfig;
  modelMappings: ModelMappingSeed[];
}
