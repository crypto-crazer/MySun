// @vitest-environment jsdom
/**
 * The preview mark (src/components/ui/Preview.tsx), on its own:
 *  - rendered: `data-preview="true"` + the exact sr-only sentence while active, nothing while not; the
 *    edge is hidden from assistive tech, not focusable, and explains itself on hover;
 *  - compiled: the class strings run through the app's own Tailwind config, so the dim, the actions it
 *    must skip and the hover / focus-within restore are checked as the CSS a browser receives (jsdom
 *    computes no styles, so this is where "hovered, the marked row reads like a public one" is pinned).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import config from '../../tailwind.config';
import { PREVIEW_DIM, PREVIEW_EDGE, PREVIEW_RESTORE, PREVIEW_SR_TEXT, PREVIEW_TIP, PreviewRegion } from '@/components/ui/Preview';

afterEach(cleanup);

describe('PreviewRegion, rendered', () => {
  it('active: the marker attribute, the exact sr-only sentence and a quiet edge with its tooltip', () => {
    const { container } = render(
      <PreviewRegion as="section" className="px-3">
        <p className="text-weak">body</p>
        <button type="button">Deposit</button>
      </PreviewRegion>,
    );
    const region = container.querySelector('section')!;
    expect(region.getAttribute('data-preview')).toBe('true');
    expect(region.className).toContain('relative');
    expect(region.className).toContain(PREVIEW_DIM);
    expect(region.className).toContain(PREVIEW_RESTORE);
    expect(PREVIEW_SR_TEXT).toBe('Not public yet');
    expect(screen.getByText('Not public yet').className).toBe('sr-only');
    // the edge: aria-hidden, nothing focusable in it, and the tooltip on hover (not the only carrier)
    const edge = region.querySelector(`[class="${PREVIEW_EDGE}"]`)!;
    const strip = edge.closest('[aria-hidden]') as HTMLElement;
    expect(strip).not.toBeNull();
    expect(strip.querySelector('[tabindex], button, a, input')).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(edge.parentElement!);
    expect(strip.querySelector('[role="tooltip"]')!.textContent).toBe(PREVIEW_TIP);
    expect(PREVIEW_TIP).toBe('Not public yet — not part of the public listing.');
    // no word on the content
    expect(region.textContent).not.toMatch(/staging/i);
  });

  it('inactive: the block renders as itself — no attribute, no mark, no dim', () => {
    const { container } = render(
      <PreviewRegion as="li" active={false} className="grid" data-vault="x">
        <span>row</span>
      </PreviewRegion>,
    );
    const li = container.querySelector('li')!;
    expect(li.hasAttribute('data-preview')).toBe(false);
    expect(li.className).toBe('grid');
    expect(li.getAttribute('data-vault')).toBe('x');
    expect(li.children).toHaveLength(1);
    expect(screen.queryByText('Not public yet')).toBeNull();
  });
});

describe('the class strings, compiled', async () => {
  const raw = [PREVIEW_EDGE, PREVIEW_DIM, PREVIEW_RESTORE].join(' ');
  const { css } = await postcss([tailwindcss({ ...config, content: [{ raw, extension: 'html' }] })]).process('@tailwind utilities;', { from: undefined });
  const rules = new Map<string, string>();
  postcss.parse(css).walkRules((r) => {
    rules.set(r.selector, r.nodes.map((d) => (d.type === 'decl' ? `${d.prop}: ${d.value.trim()}` : '')).join('; '));
  });
  const find = (pred: (sel: string) => boolean) => [...rules].filter(([sel]) => pred(sel));

  // a pseudo-class at the END of a selector (Tailwind escapes the ones inside class names)
  const state = (sel: string) => /[^\\]:(hover|focus-within)$/.test(sel);

  it('every class in the strings compiles (none silently dropped)', () => {
    expect(rules.size).toBe(raw.split(/\s+/).length);
  });

  it('the dim drops one step: strong → weak, weak → weaker', () => {
    const base = find((sel) => !state(sel) && rules.get(sel)!.startsWith('--preview-')).map(([, d]) => d).sort();
    expect(base).toEqual(['--preview-strong: var(--color-weak)', '--preview-weak: var(--color-weaker)']);
    const strong = find((s) => s.endsWith(' *)') && s.includes(' .text-strong:not('));
    const weak = find((s) => s.endsWith(' *)') && s.includes(' .text-weak:not('));
    expect(strong.map(([, d]) => d)).toEqual(['color: rgb(var(--preview-strong))']);
    expect(weak.map(([, d]) => d)).toEqual(['color: rgb(var(--preview-weak))']);
    // …and never an action, nor the block's identity
    for (const [sel] of [...strong, ...weak]) {
      expect(sel).toContain(':not(:is(a,button,[role=button],[data-preview-keep]),:is(a,button,[role=button],[data-preview-keep]) *)');
    }
  });

  it('hover and focus-within restore full contrast', () => {
    for (const pseudo of [':hover', ':focus-within']) {
      const decls = find((sel) => state(sel) && sel.endsWith(pseudo)).map(([, d]) => d).sort();
      expect(decls, pseudo).toEqual(['--preview-strong: var(--color-strong)', '--preview-weak: var(--color-weak)']);
    }
  });

  it('the edge uses the existing warning token — no new colour', () => {
    const edge = find((s) => /from-|via-|to-/.test(s)).map(([, d]) => d).join(' ');
    expect(edge).toContain('--color-fill-warning');
    expect(edge.match(/--color-[a-z-]+/g)!.every((v) => v === '--color-fill-warning')).toBe(true);
  });
});
