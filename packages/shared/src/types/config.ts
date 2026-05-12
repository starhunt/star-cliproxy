// 설정 파일 타입 정의

// EndpointType은 PluginEntry에서 사용
import type { EndpointType, ReasoningEffort } from './provider.js';

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
  max_turns?: number;              // 최대 에이전트 턴 수 (기본 50)
  permission_mode?: string;        // 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'
  allowed_tools?: string[];        // 자동 승인 도구 목록 (Read, Write 등)
  disallowed_tools?: string[];     // 차단 도구 목록
  max_budget_usd?: number;         // 요청당 최대 비용 제한 (USD)
  session_ttl_ms?: number;         // 세션 TTL (기본 1800000 = 30분)
  enable_session_reuse?: boolean;  // 세션 재사용 활성화 (기본 true)
  persist_session?: boolean;       // 디스크 세션 저장 (기본 false)
}

// Codex App Server 전용 옵션 (mode: 'app-server'일 때만 사용)
export interface CodexAppServerOptions {
  transport?: 'stdio' | 'websocket';     // 전송 방식 (기본 'stdio', websocket은 실험적)
  websocket_url?: string;                 // transport: 'websocket'일 때 URL (예: ws://127.0.0.1:4500)
  session_ttl_ms?: number;                // thread 재사용 TTL (기본 1800000 = 30분)
  enable_session_reuse?: boolean;         // thread 재사용 활성화 (기본 true)
  max_turns?: number;                     // 턴 제한
  auto_restart?: boolean;                 // 크래시 시 자동 재시작 (기본 true)
  max_restart_count?: number;             // 재시작 상한 (기본 5)
}

// Codex CLI 모드 전용 옵션 (mode: 'cli' 또는 미지정 시 적용)
export interface CodexCliOptions {
  ephemeral?: boolean;                    // codex exec --ephemeral 자동 주입 (기본 true) — 세션 jsonl 디스크 기록 차단
}

export interface ProviderConfigYaml {
  enabled: boolean;
  cli_path: string;
  default_model: string;
  max_concurrent: number;
  timeout_ms: number;
  extra_args: string[];
  working_dir?: string;
  mode?: 'cli' | 'sdk' | 'app-server';  // 실행 모드 (기본 'cli')
  sdk_options?: ClaudeSdkOptions;         // mode: 'sdk'일 때 사용 (Claude)
  app_server_options?: CodexAppServerOptions; // mode: 'app-server'일 때 사용 (Codex)
  cli_options?: CodexCliOptions;          // mode: 'cli'일 때 사용 (Codex)
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
  reasoning_effort?: ReasoningEffort;
}

export interface ValidationConfig {
  maxMessageCount: number;       // 메시지 배열 최대 수 (기본 800)
  maxMessageLength: number;      // 개별 메시지 content 최대 길이 (기본 250000)
  maxPromptLength: number;       // 전체 프롬프트 총 길이 (기본 1000000)
  maxResponseLength: number;     // CLI 응답 최대 길이 (기본 300000)
  bodyLimitBytes: number;        // HTTP 요청 본문 최대 크기 (기본 16MB)
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
