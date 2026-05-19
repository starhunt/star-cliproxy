// 대시보드 표시용 포맷터.
// 큰 숫자를 컴팩트하게 (1234567 → 1.23M), 지연 시간을 사람이 읽기 좋게.

/** 큰 숫자를 K/M/B로 압축. 1234 → "1.23K", 1925013808 → "1.93B" */
export function compactNumber(n: number, fractionDigits = 2): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) return `${(n / 1000).toFixed(fractionDigits)}K`;
  if (abs < 1_000_000_000) return `${(n / 1_000_000).toFixed(fractionDigits)}M`;
  if (abs < 1_000_000_000_000) return `${(n / 1_000_000_000).toFixed(fractionDigits)}B`;
  return `${(n / 1_000_000_000_000).toFixed(fractionDigits)}T`;
}

/** 지연 시간을 사람이 읽기 좋게. 47ms → "47ms", 1500 → "1.5s", 65000 → "1m 5s" */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** 짧은 지연 표기. 차트 라벨 등 좁은 공간용. 1500 → "1.5s" */
export function formatDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/** UTC 문자열 → 로컬 HH:MM. Invalid Date 방어. */
export function formatTime(dateStr: string): string {
  if (!dateStr || dateStr.includes('datetime')) return '--:--';
  const normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** 성공률(0~100)을 색상 등급으로 변환. */
export function successRateColor(rate: number): string {
  if (rate >= 99) return 'text-green-500 dark:text-green-400';
  if (rate >= 95) return 'text-emerald-500 dark:text-emerald-400';
  if (rate >= 80) return 'text-yellow-500 dark:text-yellow-400';
  return 'text-red-500 dark:text-red-400';
}

/** 지연을 색상 등급으로. 빠를수록 녹색, 느릴수록 적색. */
export function latencyColor(ms: number): string {
  if (ms < 1000) return 'text-green-500 dark:text-green-400';
  if (ms < 5000) return 'text-blue-500 dark:text-blue-400';
  if (ms < 30000) return 'text-yellow-500 dark:text-yellow-400';
  return 'text-red-500 dark:text-red-400';
}
