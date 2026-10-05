import { useLayoutEffect, useRef, useState } from 'react';

/** Width of an element, kept current as it resizes. Drawings use it to lay out at 1:1 instead of scaling text. */
export function useElementWidth<T extends HTMLElement>(fallback = 800): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth((w) => (el.clientWidth > 0 && el.clientWidth !== w ? el.clientWidth : w));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
