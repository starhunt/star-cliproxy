import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  // 'sm' 480px, 'md' 720px, 'lg' 960px, 'xl' 1120px
  size?: 'sm' | 'md' | 'lg' | 'xl';
  // 외부 클릭/ESC로 닫기 차단 (저장 중 등)
  blockClose?: boolean;
  // 닫기 전 확인 콜백 — false 반환 시 닫기 중단 (dirty form 등)
  onBeforeClose?: () => boolean;
  children: ReactNode;
  // 헤더 우측 액션 슬롯 (예: provider 배지)
  headerActions?: ReactNode;
  // body padding을 끄고 직접 제어하고 싶을 때
  unpadded?: boolean;
}

const SIZE_CLASS: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-[480px]',
  md: 'max-w-[720px]',
  lg: 'max-w-[960px]',
  xl: 'max-w-[1120px]',
};

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  size = 'md',
  blockClose = false,
  onBeforeClose,
  children,
  headerActions,
  unpadded = false,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousActiveRef = useRef<HTMLElement | null>(null);

  // ESC 닫기 + 페이지 스크롤 잠금 + 포커스 복원
  useEffect(() => {
    if (!open) return;

    previousActiveRef.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        tryClose();
      }
    };
    document.addEventListener('keydown', onKey);

    // 모달 패널에 초기 포커스 (스크린리더 진입 안내)
    queueMicrotask(() => panelRef.current?.focus());

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      previousActiveRef.current?.focus?.();
    };
    // tryClose는 의존성에 굳이 넣지 않음 (open 변경마다 재구성)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const tryClose = () => {
    if (blockClose) return;
    if (onBeforeClose && !onBeforeClose()) return;
    onClose();
  };

  if (!open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4 py-6"
      onMouseDown={(e) => {
        // backdrop 직접 클릭만 닫기 (자식 드래그 종료가 backdrop에서 끝나는 경우 차단)
        if (e.target === e.currentTarget) tryClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`w-full ${SIZE_CLASS[size]} max-h-[calc(100vh-3rem)] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-2xl flex flex-col outline-none`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {(title || subtitle || headerActions) && (
          <div className="flex items-start gap-3 px-5 py-4 border-b border-gray-200 dark:border-gray-800">
            <div className="flex-1 min-w-0">
              {title && (
                <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate">
                  {title}
                </h3>
              )}
              {subtitle && (
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{subtitle}</div>
              )}
            </div>
            {headerActions}
            <button
              type="button"
              onClick={tryClose}
              aria-label="Close"
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
        <div className={`flex-1 overflow-y-auto ${unpadded ? '' : 'px-5 py-4'}`}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
