export const DEFAULT_SERVER_PORT = 8300;
export const DEFAULT_DASHBOARD_PORT = 5300;
export const DEFAULT_HOST = '127.0.0.1';

export const API_KEY_PREFIX = 'sk-proxy-';
export const API_KEY_PREFIX_LENGTH = 12;

export const DEFAULT_MAX_CONCURRENT = 2;
export const DEFAULT_TIMEOUT_MS = 300_000; // 5분

export const DEFAULT_CACHE_TTL_SECONDS = 3600; // 1시간
export const DEFAULT_CACHE_MAX_ENTRIES = 1000;

export const DEFAULT_RATE_LIMIT_RPM = 60;
export const DEFAULT_RATE_LIMIT_RPD = 1000;

export const PROVIDER_NAMES = ['claude', 'codex', 'gemini'] as const;
