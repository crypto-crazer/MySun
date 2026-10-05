import { useLayoutEffect, useState, type RefObject } from 'react';
import { cx } from '@/lib/format';

interface Props {
  /** The glass track (`.seg`) this key is rendered inside. */
  track: RefObject<HTMLElement>;
  /** Selector for the chosen item inside the track, e.g. `[aria-selected="true"]`. */
  chosen: string;
  /** `key` is the lit sand key; `glass` is the secondary button's material. */
  tone?: 'key' | 'glass';
}

const tones = { key: 'seg-thumb-key', glass: 'seg-thumb-glass' };

/**
 * The one lit key on a glass track. It finds the chosen item, sits under it, and slides there when the
 * choice changes. Shared by Segmented and the token choice in the deposit card.
 */
export function SlidingKey({ track, chosen, tone = 'key' }: Props) {
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  // The first placement is not animated: the key appears in place, and only slides when the choice changes.
  const [placed, setPlaced] = useState(false);

  const read = () => {
    const el = track.current?.querySelector<HTMLElement>(chosen);
    setBox((b) => {
      if (!el) return null;
      return b && b.left === el.offsetLeft && b.width === el.offsetWidth ? b : { left: el.offsetLeft, width: el.offsetWidth };
    });
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
      className={cx('seg-thumb', tones[tone], placed && 'transition-[transform,width] duration-300 ease-dusk')}
      style={{ width: box.width, transform: `translateX(${box.left}px)` }}
    />
  );
}
