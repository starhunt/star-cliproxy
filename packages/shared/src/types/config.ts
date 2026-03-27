// 설정 파일 타입 정의

// EndpointType은 PluginEntry에서 사용
import type { EndpointType } from './provider.js';

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

// Claude Agent SDK 전용 옵션 (mode: 'sdk'일 때만 사용)
export interface ClaudeSdkOptions {
  max_turns?: number;              // 최대 에이전트 턴 수 (기본 5)
  permission_mode?: string;        // 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'
  allowed_tools?: string[];        // 자동 승인 도구 목록 (Read, Write 등)
  disallowed_tools?: string[];     // 차단 도구 목록
  max_budget_usd?: number;         // 요청당 최대 비용 제한 (USD)
  session_ttl_ms?: number;         // 세션 TTL (기본 1800000 = 30분)
  enable_session_reuse?: boolean;  // 세션 재사용 활성화 (기본 true)
  persist_session?: boolean;       // 디스크 세션 저장 (기본 false)
}

export interface ProviderConfigYaml {
  enabled: boolean;
  cli_path: string;
  default_model: string;
  max_concurrent: number;
  timeout_ms: number;
  extra_args: string[];
  working_dir?: string;
  mode?: 'cli' | 'sdk';           // 실행 모드 (기본 'cli', 하위 호환)
  sdk_options?: ClaudeSdkOptions;  // mode: 'sdk'일 때 사용
}

export interface RateLimitConfig {
  global: {
    rpm: number;
    rpd: number;
  };
  perProvider: Record<string, { rpm: number }>;
}

export interface CacheConfig {
  enabled: boolean;
  ttlSeconds: number;
  maxEntries: number;
}

export interface ModelMappingSeed {
  alias: string;
  provider: string;
  actual_model: string;
}

export interface ValidationConfig {
  maxMessageCount: number;       // 메시지 배열 최대 수 (기본 200)
  maxMessageLength: number;      // 개별 메시지 content 최대 길이 (기본 100000)
  maxPromptLength: number;       // 전체 프롬프트 총 길이 (기본 500000)
  maxResponseLength: number;     // CLI 응답 최대 길이 (기본 500000)
  bodyLimitBytes: number;        // HTTP 요청 본문 최대 크기 (기본 10MB)
}

export interface PluginEntry {
  path: string;                                              // 플러그인 디렉토리 경로
  config?: Partial<ProviderConfigYaml> & Record<string, unknown>;  // 기본 설정 + 플러그인 고유 설정
}

export interface AppConfig {
  server: ServerConfig;
  dashboard: DashboardConfig;
  database: DatabaseConfig;
  auth: AuthConfig;
  providers: Record<string, ProviderConfigYaml>;
  plugins: PluginEntry[];
  rateLimits: RateLimitConfig;
  cache: CacheConfig;
  validation: ValidationConfig;
  modelMappings: ModelMappingSeed[];
}
