// 모델/프로바이더 시각화에 사용하는 확장 컬러 팔레트.
// 시각적 우선순위를 위해: 상위 N개는 풍부한 채도, 그 외는 무채색 톤으로 흐릿하게.

export interface ColorPair {
  bar: string;   // 차트 바 (반투명)
  dot: string;   // 레전드 dot (불투명)
  text: string;  // 텍스트 강조
}

// 18색 확장 팔레트. 색상환 위치를 균등 분산해서 인접 모델이 잘 구분됨.
export const MODEL_PALETTE: ColorPair[] = [
  { bar: 'bg-blue-500/70',    dot: 'bg-blue-400',    text: 'text-blue-500 dark:text-blue-300' },
  { bar: 'bg-emerald-500/70', dot: 'bg-emerald-400', text: 'text-emerald-500 dark:text-emerald-300' },
  { bar: 'bg-purple-500/70',  dot: 'bg-purple-400',  text: 'text-purple-500 dark:text-purple-300' },
  { bar: 'bg-amber-500/70',   dot: 'bg-amber-400',   text: 'text-amber-500 dark:text-amber-300' },
  { bar: 'bg-pink-500/70',    dot: 'bg-pink-400',    text: 'text-pink-500 dark:text-pink-300' },
  { bar: 'bg-cyan-500/70',    dot: 'bg-cyan-400',    text: 'text-cyan-500 dark:text-cyan-300' },
  { bar: 'bg-orange-500/70',  dot: 'bg-orange-400',  text: 'text-orange-500 dark:text-orange-300' },
  { bar: 'bg-indigo-500/70',  dot: 'bg-indigo-400',  text: 'text-indigo-500 dark:text-indigo-300' },
  { bar: 'bg-rose-500/70',    dot: 'bg-rose-400',    text: 'text-rose-500 dark:text-rose-300' },
  { bar: 'bg-teal-500/70',    dot: 'bg-teal-400',    text: 'text-teal-500 dark:text-teal-300' },
  { bar: 'bg-violet-500/70',  dot: 'bg-violet-400',  text: 'text-violet-500 dark:text-violet-300' },
  { bar: 'bg-lime-500/70',    dot: 'bg-lime-400',    text: 'text-lime-500 dark:text-lime-300' },
  { bar: 'bg-fuchsia-500/70', dot: 'bg-fuchsia-400', text: 'text-fuchsia-500 dark:text-fuchsia-300' },
  { bar: 'bg-sky-500/70',     dot: 'bg-sky-400',     text: 'text-sky-500 dark:text-sky-300' },
  { bar: 'bg-yellow-500/70',  dot: 'bg-yellow-400',  text: 'text-yellow-600 dark:text-yellow-300' },
  { bar: 'bg-red-500/70',     dot: 'bg-red-400',     text: 'text-red-500 dark:text-red-300' },
  { bar: 'bg-green-500/70',   dot: 'bg-green-400',   text: 'text-green-500 dark:text-green-300' },
  { bar: 'bg-slate-500/70',   dot: 'bg-slate-400',   text: 'text-slate-500 dark:text-slate-300' },
];

// "기타" 또는 비강조 항목용 회색 톤.
export const MUTED_COLOR: ColorPair = {
  bar: 'bg-gray-300/60 dark:bg-gray-700/60',
  dot: 'bg-gray-400 dark:bg-gray-600',
  text: 'text-gray-500 dark:text-gray-500',
};

/**
 * 모델 사용량 순위에 따라 색상을 할당한다.
 * - 상위 `topN` 모델은 풍부한 팔레트 색상
 * - 그 외 모델은 회색 톤 (시각적 우선순위 강조)
 *
 * @param sortedModels 사용량 내림차순으로 정렬된 모델 이름 배열
 * @param topN 강조할 상위 개수 (기본 12, 팔레트 크기와 무관하게 사용자가 조절)
 */
export function buildColorMap(sortedModels: string[], topN = 12): Map<string, ColorPair> {
  const map = new Map<string, ColorPair>();
  sortedModels.forEach((name, i) => {
    if (i < topN && i < MODEL_PALETTE.length) {
      map.set(name, MODEL_PALETTE[i]);
    } else {
      map.set(name, MUTED_COLOR);
    }
  });
  return map;
}

// 상태별 dot 색상 (시스템 상태에서 사용)
export const STATUS_DOT: Record<string, string> = {
  healthy: 'bg-green-400',
  unhealthy: 'bg-red-400',
  unknown: 'bg-yellow-400',
};

// 요청 상태 텍스트 색상
export const REQUEST_STATUS_STYLE: Record<string, string> = {
  success: 'text-green-400',
  error: 'text-red-400',
  timeout: 'text-yellow-400',
  cancelled: 'text-gray-400',
};
