import { useStore } from '@/store/useStore';
import { cx } from '@/lib/format';

export function ToastHost() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cx(
            'animate-fade-in bg-background-elevated border border-stroke-strong rounded-lg shadow-pop px-4 py-3.5 flex items-start gap-3',
          )}
        >
          <span
            className={cx(
              'mt-1.5 h-2 w-2 shrink-0',
              t.tone === 'accent' ? 'bg-accent' : t.tone === 'success' ? 'bg-success' : t.tone === 'warning' ? 'bg-warning' : 'bg-strong',
            )}
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-strong num">{t.title}</div>
            {t.detail && <div className="text-xs text-weak mt-0.5 num">{t.detail}</div>}
          </div>
          <button onClick={() => dismiss(t.id)} className="text-weaker hover:text-strong text-xs leading-none mt-0.5" aria-label="Dismiss">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
