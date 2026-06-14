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

// Claude Code Channel worker 옵션 (mode: 'channel-worker'일 때 사용)
// 외부에서 실행 중인 Channel bridge에 job을 제출하고 완료 상태를 polling한다.
// managed=true이면 star-cliproxy가 내장 bridge 프로세스를 직접 spawn/관리한다.
export interface ClaudeChannelOptions {
  endpoint_url?: string;            // 예: http://127.0.0.1:8788 (managed면 bridge_port로 자동 유추)
  api_key?: string;                 // 선택적 Bearer token (managed bridge에도 그대로 주입)
  poll_interval_ms?: number;        // 상태 polling 간격 (기본 500ms)
  result_timeout_ms?: number;       // job 완료 대기 시간 (기본 provider timeout_ms)
  response_schema?: Record<string, unknown>; // bridge에 전달할 선택적 JSON schema
  isolation?: 'external' | 'one-job-per-worker' | 'shared-session';
  // --- bridge 라이프사이클 (star-cliproxy가 직접 관리할 때) ---
  managed?: boolean;                // true면 star-cliproxy가 bridge 프로세스를 spawn/supervise (기본 false=외부 bridge)
  auto_start?: boolean;             // 서버 부팅 시 managed bridge 자동 시작 (기본 false)
  bridge_port?: number;             // 내장 bridge 리스닝 포트 (기본 8788)
  bridge_command?: string;          // 커스텀 bridge 실행 커맨드. 비우면 내장 bridge 사용 (예: "node my-bridge.js")
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
  enable_session_reuse?: boolean;         // codex exec resume <thread_id> 기반 세션 재사용 (기본 false). true 시 ephemeral은 강제 false
  session_ttl_ms?: number;                // 세션 TTL (기본 1800000 = 30분). enable_session_reuse=true일 때만 유효
}

export interface ProviderConfigYaml {
  enabled: boolean;
  cli_path: string;
  default_model: string;
  max_concurrent: number;
  timeout_ms: number;
  extra_args: string[];
  working_dir?: string;
  mode?: 'cli' | 'sdk' | 'app-server' | 'channel-worker';  // 실행 모드 (기본 'cli')
  sdk_options?: ClaudeSdkOptions;         // mode: 'sdk'일 때 사용 (Claude)
  channel_options?: ClaudeChannelOptions;  // mode: 'channel-worker'일 때 사용 (Claude)
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
  provider_overrides?: ProviderOverrides;  // 모델 레벨 옵션 오버라이드 (화이트리스트 기반)
}

// 모델 매핑 단위 오버라이드. ProviderConfigYaml의 화이트리스트 키만 허용
// (mergeProviderConfig에서 검증). yaml/DB 모두 동일 구조 사용.
export interface ProviderOverrides {
  mode?: ProviderConfigYaml['mode'];
  extra_args?: string[];
  timeout_ms?: number;
  working_dir?: string;
  cli_options?: Partial<CodexCliOptions>;
  sdk_options?: Partial<ClaudeSdkOptions>;
  channel_options?: Partial<ClaudeChannelOptions>;
}

// 오버라이드 화이트리스트 (codex 한정 1차). 화이트리스트 외 키는 silent drop.
// 다른 프로바이더 추가 시 별도 화이트리스트 정의 + mergeProviderConfig에 provider별 분기.
export const CODEX_OVERRIDE_ALLOWED_KEYS = [
  'extra_args',
  'timeout_ms',
  'working_dir',
  'cli_options.ephemeral',
  'cli_options.enable_session_reuse',
  'cli_options.session_ttl_ms',
] as const;
export type CodexOverrideKey = typeof CODEX_OVERRIDE_ALLOWED_KEYS[number];

export const CLAUDE_OVERRIDE_ALLOWED_KEYS = [
  'mode',
  'extra_args',
  'timeout_ms',
  'working_dir',
  'sdk_options.max_turns',
  'sdk_options.permission_mode',
  'sdk_options.allowed_tools',
  'sdk_options.disallowed_tools',
  'sdk_options.max_budget_usd',
  'sdk_options.session_ttl_ms',
  'sdk_options.enable_session_reuse',
  'sdk_options.persist_session',
  'channel_options.endpoint_url',
  'channel_options.api_key',
  'channel_options.poll_interval_ms',
  'channel_options.result_timeout_ms',
  'channel_options.response_schema',
  'channel_options.isolation',
] as const;
export type ClaudeOverrideKey = typeof CLAUDE_OVERRIDE_ALLOWED_KEYS[number];

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
