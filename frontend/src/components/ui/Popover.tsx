import { useEffect, type RefObject } from 'react';

/** The panel a popover opens: under its trigger, flush right, on the popover surface. Width and padding are the caller's. */
export const POPOVER_PANEL = 'absolute right-0 top-full mt-2 bg-background-popover border border-stroke-strong rounded-md shadow-pop animate-fade-in z-40';

/**
 * Closes an open popover (a menu, the wallet panel) on a press outside `ref` or on Escape. Escape
 * stops at the popover, so an overlay underneath that also listens for it stays open.
 */
export function useDismiss(ref: RefObject<HTMLElement>, open: boolean, setOpen: (open: boolean) => void) {
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, open, setOpen]);
}
