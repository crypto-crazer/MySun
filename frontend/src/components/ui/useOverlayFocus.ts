import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** What Tab can reach inside `root`, in DOM order; a closed `<details>` hides all but its summary. */
function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    const details = el.parentElement?.closest('details');
    return !details || details.open || (el.tagName === 'SUMMARY' && el.parentElement === details);
  });
}

/**
 * A modal overlay's focus while `open`: Tab / Shift+Tab cycle inside `ref`, the page under it does not
 * scroll, and on close focus goes back to whatever had it when the overlay opened. Escape stays with
 * the overlay (and `useDismiss` menus inside it).
 */
export function useOverlayFocus(ref: RefObject<HTMLElement>, open: boolean) {
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  // Read while rendering the opening frame: an autoFocus field in the overlay takes focus on commit, before any effect runs
  if (open && !wasOpen.current) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    if (node && !node.contains(document.activeElement)) node.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !node) return;
      const items = focusables(node);
      const active = document.activeElement;
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
      } else if (e.shiftKey && (active === items[0] || active === node || !node.contains(active))) {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (!e.shiftKey && (active === items[items.length - 1] || !node.contains(active))) {
        e.preventDefault();
        items[0].focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      // Only a real close (the overlay is gone): StrictMode's dev re-run must not pull focus out of it
      if (node?.isConnected) return;
      const back = opener.current;
      if (back?.isConnected) back.focus();
    };
  }, [open, ref]);
}
