import type { ReactNode } from 'react';

interface ProviderBadgeProps {
  provider: string;
  size?: 'sm' | 'md';
  // chip 형태로 표시 (테이블 셀, 폼). false면 icon만.
  showLabel?: boolean;
  // 추가 className 합성
  className?: string;
}

// 빌트인 + 알려진 플러그인 색상 매핑. Tailwind safelist를 위해 정적 클래스 사용.
// 각 provider마다 light/dark 토큰을 명시해야 tailwind JIT가 emit한다.
interface ProviderStyle {
  // chip 배경 + 텍스트 (light/dark 둘 다)
  chip: string;
  // 좌측 컬러바 (사용하는 곳에서 색만 가져갈 때)
  accent: string;
  // SVG 아이콘 — 16x16 viewBox 24
  icon: ReactNode;
  label: string;
}

const ICON_PATHS: Record<string, ReactNode> = {
  // Claude — 별 모양 (Anthropic 컬러 아이덴티티 ★)
  claude: (
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3z" />
  ),
  // Codex/OpenAI — 6-knot (꼬임 매듭) 단순화
  codex: (
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4" />
  ),
  // Copilot — 채팅 말풍선 + 짧은 꼬리
  copilot: (
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
  ),
  // Gemini — 4점 별 (Google Gemini 마크 단순화)
  gemini: (
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z" />
  ),
  // Antigravity — 위로 향하는 화살표(중력 반대) + 원
  agy: (
    <>
      <circle cx="12" cy="12" r="9" strokeLinecap="round" strokeLinejoin="round" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 17V8m-3 3l3-3 3 3" />
    </>
  ),
};

const STYLE_MAP: Record<string, ProviderStyle> = {
  claude: {
    chip: 'bg-blue-100 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-300/60 dark:border-blue-500/30',
    accent: 'bg-blue-500',
    icon: ICON_PATHS.claude,
    label: 'Claude',
  },
  codex: {
    chip: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-300/60 dark:border-emerald-500/30',
    accent: 'bg-emerald-500',
    icon: ICON_PATHS.codex,
    label: 'Codex',
  },
  copilot: {
    chip: 'bg-violet-100 dark:bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-300/60 dark:border-violet-500/30',
    accent: 'bg-violet-500',
    icon: ICON_PATHS.copilot,
    label: 'Copilot',
  },
  gemini: {
    chip: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-300/60 dark:border-amber-500/30',
    accent: 'bg-amber-500',
    icon: ICON_PATHS.gemini,
    label: 'Gemini',
  },
  agy: {
    chip: 'bg-cyan-100 dark:bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-300/60 dark:border-cyan-500/30',
    accent: 'bg-cyan-500',
    icon: ICON_PATHS.agy,
    label: 'Antigravity',
  },
};

// 미등록 provider용 결정론적 폴백 — 이름 해시로 5색 중 하나에 할당
const FALLBACK_STYLES: ProviderStyle[] = [
  { chip: 'bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-300/60 dark:border-rose-500/30', accent: 'bg-rose-500', icon: ICON_PATHS.claude, label: '' },
  { chip: 'bg-pink-100 dark:bg-pink-500/15 text-pink-700 dark:text-pink-300 border-pink-300/60 dark:border-pink-500/30', accent: 'bg-pink-500', icon: ICON_PATHS.claude, label: '' },
  { chip: 'bg-fuchsia-100 dark:bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300 border-fuchsia-300/60 dark:border-fuchsia-500/30', accent: 'bg-fuchsia-500', icon: ICON_PATHS.claude, label: '' },
  { chip: 'bg-orange-100 dark:bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-300/60 dark:border-orange-500/30', accent: 'bg-orange-500', icon: ICON_PATHS.claude, label: '' },
  { chip: 'bg-teal-100 dark:bg-teal-500/15 text-teal-700 dark:text-teal-300 border-teal-300/60 dark:border-teal-500/30', accent: 'bg-teal-500', icon: ICON_PATHS.claude, label: '' },
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function getProviderStyle(provider: string): ProviderStyle {
  const known = STYLE_MAP[provider];
  if (known) return known;
  const fb = FALLBACK_STYLES[hash(provider) % FALLBACK_STYLES.length];
  return { ...fb, label: provider };
}

export function ProviderBadge({
  provider,
  size = 'sm',
  showLabel = true,
  className = '',
}: ProviderBadgeProps) {
  const style = getProviderStyle(provider);
  const iconSize = size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5';
  const padding = size === 'sm' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-1 text-xs';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded border font-medium ${style.chip} ${padding} ${className}`}
      title={style.label || provider}
    >
      <svg className={iconSize} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        {style.icon}
      </svg>
      {showLabel && <span className="font-semibold tracking-wide">{style.label || provider}</span>}
    </span>
  );
}
