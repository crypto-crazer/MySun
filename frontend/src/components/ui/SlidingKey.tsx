import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { cx } from '@/lib/format';

interface Props {
  /** The groove (`.well.groove`) this key is rendered inside. */
  track: RefObject<HTMLElement>;
  /** Selector for the chosen item inside the track, e.g. `[aria-selected="true"]`. */
  chosen: string;
}

/**
 * The one glass key in a groove. It finds the chosen item, sits under it, and slides there when the
 * choice changes. Shared by Segmented and the token choice in the deposit card.
 */
export function SlidingKey({ track, chosen }: Props) {
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  // The first placement is not animated: the key appears in place, and only slides when the choice changes.
  const [placed, setPlaced] = useState(false);

  // The last box handed to setBox. Comparing against it, not inside an updater, keeps an unchanged
  // reading from queuing an update at all: a queued updater can be replayed from an older state
  // (a skipped lower-priority update), return a fresh object each time and loop the layout effect.
  const last = useRef<{ left: number; width: number } | null>(null);
  const read = () => {
    const el = track.current?.querySelector<HTMLElement>(chosen);
    const next = el ? { left: el.offsetLeft, width: el.offsetWidth } : null;
    const prev = last.current;
    if (prev === next || (prev && next && prev.left === next.left && prev.width === next.width)) return;
    last.current = next;
    setBox(next);
  };
  // Measured after every render (the choice or a label may have changed), and again when the track resizes.
  useLayoutEffect(read);
  useLayoutEffect(() => {
    const el = track.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!box || placed) return;
    const id = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(id);
  }, [box, placed]);

  if (!box) return null;
  return (
    <span
      aria-hidden
      className={cx('seg-thumb seg-thumb-glass', placed && 'transition-[transform,width] duration-300 ease-dusk')}
      style={{ width: box.width, transform: `translateX(${box.left}px)` }}
    />
  );
}
