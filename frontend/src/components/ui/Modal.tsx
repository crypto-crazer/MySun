import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({ open, onClose, title, children, footer }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-fill-overlay backdrop-blur-[4px]" onClick={onClose} />
      <div className="relative w-full max-w-md bg-background-elevated border border-stroke-strong rounded-lg shadow-pop animate-fade-in">
        <header className="px-5 h-12 flex items-center border-b border-stroke-weak">
          <h2 className="display text-md font-semibold">{title}</h2>
        </header>
        <div className="px-5 py-4 text-sm text-weak leading-relaxed">{children}</div>
        {footer && <footer className="px-5 py-3 border-t border-stroke-weak flex justify-end gap-2">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
