import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '@/lib/format';
import { Tooltip } from './Tooltip';

/**
 * The preview mark: how the app says "this is not public yet" without writing a word on the content.
 * The marked block gets a warning-tinted edge down its left side (fading toward the bottom), its
 * ambient text drops one emphasis step, a tooltip on the edge explains it, and a screen reader hears
 * "Not public yet". Today it marks the registry's `staging` vaults, visible only in team mode
 * (src/lib/teamMode.ts): their Markets rows (rows only — a page carries none).
 *
 * A future staging surface imports this and wraps its block in <PreviewRegion active={…}> — never a
 * new tag or a word. Rules the classes encode:
 *  - the dim moves `text-strong` → `text-weak` and `text-weak` → `text-weaker`, and nothing else;
 *  - it never reaches an action (`a`, `button`, `[role=button]` and anything inside one), nor the
 *    block's identity — put `data-preview-keep` on the name so it stays `text-strong`;
 *  - hover and focus-within on the block restore full contrast;
 *  - the descendants keep their own classes: the dim lives on the block, so a marked and an unmarked
 *    block render identical markup apart from the block itself and the mark.
 * The edge is absolutely placed in the block's padding, so the block's layout does not move.
 */

/** The edge itself: 3px of the warning tint, fading toward the bottom. */
export const PREVIEW_EDGE = 'block h-full w-[3px] bg-gradient-to-b from-fill-warning via-fill-warning/60 to-fill-warning/0';

/**
 * One emphasis step down for the block's ambient text. The step is carried by two variables, so the
 * restore below only has to set them back. Written out in full: Tailwind reads class names from source.
 */
export const PREVIEW_DIM =
  '[--preview-strong:var(--color-weak)] [--preview-weak:var(--color-weaker)] ' +
  '[&_.text-strong:not(:is(a,button,[role=button],[data-preview-keep]),:is(a,button,[role=button],[data-preview-keep])_*)]:text-[rgb(var(--preview-strong))] ' +
  '[&_.text-weak:not(:is(a,button,[role=button],[data-preview-keep]),:is(a,button,[role=button],[data-preview-keep])_*)]:text-[rgb(var(--preview-weak))]';

/** Full contrast again while the block is hovered or holds focus. */
export const PREVIEW_RESTORE =
  'hover:[--preview-strong:var(--color-strong)] hover:[--preview-weak:var(--color-weak)] ' +
  'focus-within:[--preview-strong:var(--color-strong)] focus-within:[--preview-weak:var(--color-weak)]';

/** The exact sentence a screen reader hears where a sighted user sees the edge. */
export const PREVIEW_SR_TEXT = 'Not public yet';
export const PREVIEW_TIP = 'Not public yet — not part of the public listing.';

/**
 * The edge with its tooltip, and the sr-only sentence. Goes inside a positioned block (PreviewRegion
 * is one). The edge's hover strip is 12px wide and not focusable; it is hidden from assistive tech,
 * which gets the sentence instead.
 */
export function PreviewMark({ className }: { className?: string }) {
  // `className` places the strip horizontally (default: the block's left edge)
  return (
    <>
      <span aria-hidden className={cx('absolute inset-y-0 z-[1] flex w-3 cursor-help', className ?? 'left-0')}>
        <Tooltip content={PREVIEW_TIP} align="start" className="h-full w-full">
          <span className={PREVIEW_EDGE} />
        </Tooltip>
      </span>
      <span className="sr-only">{PREVIEW_SR_TEXT}</span>
    </>
  );
}

type RegionTag = 'div' | 'section' | 'header' | 'li';

interface RegionProps extends HTMLAttributes<HTMLElement> {
  /** Off: the block renders as itself, unmarked. */
  active?: boolean;
  as?: RegionTag;
  /** The mark's horizontal position, replacing `left-0` (e.g. `-left-4` puts it in the gutter of a block with no left padding). */
  markClassName?: string;
  children: ReactNode;
}

/** A block that, while `active`, carries the mark, the dim, the restore and `data-preview="true"`. */
export function PreviewRegion({ active = true, as: Tag = 'div', markClassName, className, children, ...rest }: RegionProps) {
  return (
    <Tag {...rest} data-preview={active ? 'true' : undefined} className={cx(className, active && cx('relative', PREVIEW_DIM, PREVIEW_RESTORE))}>
      {active && <PreviewMark className={markClassName} />}
      {children}
    </Tag>
  );
}
