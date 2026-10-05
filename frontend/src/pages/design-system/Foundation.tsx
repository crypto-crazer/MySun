import { useState, type CSSProperties, type ReactNode } from 'react';
import { Mark, MarkLoader } from '@/components/brand/Mark';
import { Button } from '@/components/ui/Button';
import { BRAND } from '@/lib/brand';
import { cx } from '@/lib/format';
import { PRIMITIVES, SEMANTIC_GROUPS, primitiveHex, type PrimitiveName, type SemanticGroup, type SemanticToken } from '@/lib/tokens';
import { Code, Rule, Section, Specimen, SubSection, px, useComputed } from './parts';

export function FoundationContent() {
  return (
    <>
      <Typography />
      <BaseColors />
      <SemanticColors />
      <Surfaces />
      <Shape />
      <Spacing />
      <Motion />
      <Marks />
      <Layering />
      <Focus />
    </>
  );
}

// ── Typography ────────────────────────────────────────────────────────

const SCALE: Array<{ cls: string; use: string }> = [
  { cls: 'text-2xs', use: 'Eyebrows, badges' },
  { cls: 'text-xs', use: 'Captions, hints, chart ticks' },
  { cls: 'text-sm', use: 'Supporting text, compact buttons' },
  { cls: 'text-base', use: 'Body, the default button' },
  { cls: 'text-md', use: 'Large button, dialog title' },
  { cls: 'text-lg', use: 'Amount being typed' },
  { cls: 'text-xl', use: 'Sub-headings' },
  { cls: 'text-2xl', use: 'Section titles' },
  { cls: 'text-3xl', use: 'A large reading' },
  { cls: 'text-4xl', use: 'The reading a page is about' },
];

const WEIGHTS: Array<{ cls: string; face?: string; note: string }> = [
  { cls: 'font-thin', face: 'font-serif', note: 'Zodiak only: the largest titles' },
  { cls: 'font-light', face: 'font-serif', note: 'Zodiak titles' },
  { cls: 'font-normal', note: 'Body, and every reading' },
  { cls: 'font-medium', note: 'Emphasis: labels, buttons, UI titles' },
  { cls: 'font-semibold', note: 'Same as medium. Geist carries emphasis at 500' },
  { cls: 'font-bold', note: 'The ceiling. Rare' },
];

function Typography() {
  return (
    <Section
      id="typography"
      title="Typography"
      source="tailwind.config.ts · src/index.css"
      lede="Four faces, each with one job. The serif speaks for the page, Geist carries the interface, and every figure is set in Switzer so a column of numbers reads as one hand."
    >
      <SubSection title="Families">
        <div className="divide-y divide-stroke-weak border-y border-stroke-weak">
          <Family name="Zodiak" cls="font-serif" role="Page titles and vault names. Thin at the largest sizes, light below, never bold. Italic marks one word.">
            <p className="title font-thin text-[clamp(38px,5vw,64px)] leading-[1.02]">Markets move. Your range <em className="font-light">follows.</em></p>
          </Family>
          <Family name="Geist" cls="font-sans" role="Everything read or operated: labels, body, controls.">
            <p className="max-w-[46ch] text-md text-strong">Deposits and rebalancing are paused by the vault owner. Redeem stays available.</p>
          </Family>
          <Family name="Switzer Figures" cls="font-sans, font-display" role="Digits and the signs that travel with them ($ % + , . −). It leads both sans stacks through a unicode-range, so a figure picks it up with no class.">
            <p className="display num text-3xl">$11.4M <span className="text-weaker">·</span> 40.0% <span className="text-weaker">·</span> 2,710.0 <span className="text-weaker">·</span> +1.05%</p>
          </Family>
          <Family name="Geist Mono" cls="font-mono" role="Addresses, hashes, code.">
            <p className="font-mono text-md text-strong">0x3C44CdDd…93BC</p>
          </Family>
        </div>
      </SubSection>

      <SubSection title="Roles" note="A handful of utility classes carry the repeated treatments, so a page asks for a role rather than rebuilding it from sizes and weights.">
        <div className="divide-y divide-stroke-weak border-y border-stroke-weak">
          <Role cls=".title" note="Page-level titles: the serif, light, tight"><span className="title text-2xl">Vault token price</span></Role>
          <Role cls=".title.font-thin" note="The title a page opens with"><span className="title font-thin text-4xl">ETH / USDG</span></Role>
          <Role cls=".display" note="UI titles: Geist, medium"><span className="display text-md">Price range</span></Role>
          <Role cls=".display.num" note="A reading: one weight lighter than a title"><span className="display num text-[22px] leading-7">$2.4M</span></Role>
          <Role cls=".eyebrow" note="The small caps label that names a reading"><span className="eyebrow">Total TVL</span></Role>
          <Role cls=".wordmark" note="The name in the header"><span className="wordmark">{BRAND.name}</span></Role>
        </div>
      </SubSection>

      <SubSection title="Scale" note="Sizes and line heights are read off the rendered sample.">
        <div className="divide-y divide-stroke-weak border-y border-stroke-weak">
          {SCALE.map((s) => <ScaleRow key={s.cls} {...s} />)}
        </div>
      </SubSection>

      <SubSection title="Weights">
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
          {WEIGHTS.map((w) => <WeightTile key={w.cls} {...w} />)}
        </div>
      </SubSection>

      <SubSection title="Figures" note="Figures are tabular everywhere, so amounts line up without a monospace face.">
        <Specimen>
          <div className="grid w-full max-w-[280px] gap-0 text-md">
            {[['ETH', '1,204.50'], ['USDG', '311,870.00'], ['NVDA', '18.25']].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-stroke-weak py-2 last:border-0">
                <span className="text-weak">{k}</span>
                <span className="num text-strong">{v}</span>
              </div>
            ))}
          </div>
        </Specimen>
      </SubSection>
    </Section>
  );
}

function Family({ name, cls, role, children }: { name: string; cls: string; role: string; children: ReactNode }) {
  return (
    <div className="grid items-center gap-x-10 gap-y-4 py-6 md:grid-cols-[220px_minmax(0,1fr)]">
      <div className="grid gap-1.5">
        <h4 className="display text-md">{name}</h4>
        <code className="font-mono text-xs text-weaker">{cls}</code>
        <p className="text-sm text-weak">{role}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Role({ cls, note, children }: { cls: string; note: string; children: ReactNode }) {
  return (
    <div className="grid items-baseline gap-x-10 gap-y-1.5 py-3.5 md:grid-cols-[220px_minmax(0,1fr)]">
      <div className="grid gap-0.5">
        <code className="font-mono text-xs text-strong">{cls}</code>
        <span className="text-sm text-weaker">{note}</span>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function ScaleRow({ cls, use }: { cls: string; use: string }) {
  const [ref, [size, line]] = useComputed<HTMLSpanElement>(['font-size', 'line-height']);
  return (
    <div className="grid items-baseline gap-x-10 gap-y-1 py-3 md:grid-cols-[220px_minmax(0,1fr)]">
      <div className="flex items-baseline gap-3">
        <code className="w-[68px] shrink-0 font-mono text-xs text-strong">{cls}</code>
        <span className="num w-[52px] shrink-0 font-mono text-xs text-weaker">{size ? `${px(size)}/${px(line)}` : ''}</span>
        <span className="text-xs text-weaker md:hidden">{use}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-6">
        <span ref={ref} className={cx(cls, 'truncate text-strong')}>Earning 40.0% APR</span>
        <span className="hidden text-xs text-weaker md:inline">{use}</span>
      </div>
    </div>
  );
}

function WeightTile({ cls, face = 'font-sans', note }: { cls: string; face?: string; note: string }) {
  const [ref, [weight]] = useComputed<HTMLSpanElement>(['font-weight']);
  return (
    <div className="grid content-start gap-1.5 border-t border-stroke-strong pt-3">
      <span ref={ref} className={cx(cls, face, 'text-3xl text-strong')}>Aa</span>
      <code className="font-mono text-xs text-strong">{cls} <span className="text-weaker">{weight}</span></code>
      <span className="text-xs text-weaker">{note}</span>
    </div>
  );
}

// ── Base colours ──────────────────────────────────────────────────────

const RAMPS: Array<{ title: string; note: string; names: PrimitiveName[] }> = [
  { title: 'Plum', note: 'The ground. Four tones, darker as the number rises.', names: ['plum-950', 'plum-900', 'plum-800', 'plum-700'] },
  { title: 'Sand', note: 'Everything written or ruled. 240 and 120 are sand at 24% and 12% over night, kept as solid colours.', names: ['sand-bright', 'sand-1000', 'sand-700', 'sand-500', 'sand-240', 'sand-120'] },
  { title: 'Sun', note: 'The price, and the reward that follows it. Nothing structural is ever this colour.', names: ['sun-bright', 'sun-1000', 'sun-ink'] },
  { title: 'Outcomes', note: 'Gain, loss and caution. The tan is dull on purpose, so it is never mistaken for the sun.', names: ['green-1000', 'red-1000', 'tan-1000', 'rose-1000', 'black'] },
];

function BaseColors() {
  return (
    <Section
      id="base-colors"
      title="Base colors"
      source="src/lib/tokens.ts"
      lede={<>The palette, named by ramp and level. These are the raw values and nothing more: a component never names one. They have no utility class, so <Code>text-sand-700</Code> does not exist.</>}
    >
      {RAMPS.map((r) => (
        <SubSection key={r.title} title={r.title} note={r.note}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
            {r.names.map((name) => (
              <div key={name} className="grid content-start gap-2">
                <div className="h-[72px] rounded border border-stroke-weak" style={{ background: `rgb(var(--color-${name}))` }} />
                <div className="grid gap-0.5">
                  <code className="font-mono text-xs text-strong">{name}</code>
                  <span className="font-mono text-2xs text-weaker">{primitiveHex(name)}</span>
                  <span className="text-xs text-weaker">{PRIMITIVES[name].note}</span>
                </div>
              </div>
            ))}
          </div>
        </SubSection>
      ))}
    </Section>
  );
}

// ── Semantic colours ──────────────────────────────────────────────────

function SemanticColors() {
  return (
    <Section
      id="semantic-colors"
      title="Semantic colors"
      source="src/lib/tokens.ts"
      lede="Every colour a component can reach is named for its role and points at one base colour. Changing what a role looks like is one line in the token file; no component is touched."
    >
      <SubSection title="Rules">
        <div className="divide-y divide-stroke-weak border-y border-stroke-weak">
          <Rule title="Semantic classes only" yes={['bg-background-elevated', 'text-weak']} no={[arbitrary('bg', '#2A1B20'), 'text-sand-700']}>
            No hex, no arbitrary colour, no base colour in a class. If the role you need is missing, add a token.
          </Rule>
          <Rule title="The utility picks the family" yes={['text-weaker', 'bg-fill-weak', 'border-stroke-strong']} no={['text-fill-weak', 'bg-stroke-strong']}>
            Text takes a content token. A background takes a surface or a fill. A border, divider or ring takes a stroke.
          </Rule>
          <Rule title="A mark is drawn like ink" yes={['after:bg-strong', 'fill-weaker', 'bg-success']}>
            Ticks, indicator rules, status dots, legend swatches and SVG shapes take a content token, whatever utility draws them. A hairline drawn as a shape takes a stroke token.
          </Rule>
          <Rule title="Opacity is a modifier" yes={['bg-fill-error/10', 'border-stroke-error/40']} no={[arbitrary('bg', 'rgb(255_138_143/0.1)')]}>
            Tints and soft edges are a semantic token with an opacity modifier, never a new colour.
          </Rule>
          <Rule title="The sun means price" yes={['text-accent', 'text-success', 'text-error']}>
            Sun is the price and the reward that follows it. Gain and loss have their own colours and always come with words.
          </Rule>
        </div>
      </SubSection>

      {SEMANTIC_GROUPS.map((g) => (
        <SubSection key={g.id} title={g.title} note={<>{g.note}<span className="mt-1.5 block font-mono text-xs text-weak">{g.utilities}</span></>}>
          <div className="divide-y divide-stroke-weak border-y border-stroke-weak">
            {g.tokens.map((t) => <TokenRow key={t.name} group={g} token={t} />)}
          </div>
        </SubSection>
      ))}
    </Section>
  );
}

// The "not" examples are assembled at runtime, so Tailwind's scanner never sees them as real classes.
const arbitrary = (utility: string, value: string) => `${utility}-[${value}]`;

const UTILITY: Record<SemanticGroup['id'], string> = { content: 'text', background: 'bg', fill: 'bg', stroke: 'border' };

function TokenRow({ group, token }: { group: SemanticGroup; token: SemanticToken }) {
  const cls = token.cssOnly ? `--color-${token.name}` : `${UTILITY[group.id]}-${token.name}`;
  return (
    <div className="grid grid-cols-[48px_minmax(0,1fr)] items-center gap-x-4 gap-y-0.5 py-2.5 md:grid-cols-[48px_minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,1.6fr)]">
      <TokenChip group={group.id} token={token} />
      <code className="font-mono text-xs text-strong [overflow-wrap:anywhere]">{cls}</code>
      <span className="col-start-2 font-mono text-xs text-weaker md:col-start-3">
        {token.ref} · {primitiveHex(token.ref)}{token.alpha !== undefined && ` at ${token.alpha * 100}%`}
      </span>
      <span className="col-start-2 text-sm text-weak md:col-start-4">{token.use}</span>
    </div>
  );
}

/** How a token is shown depends on what it paints: a glyph for content, a tile for a surface, an outline for a stroke. */
function TokenChip({ group, token }: { group: SemanticGroup['id']; token: SemanticToken }) {
  const color = `rgb(var(--color-${token.name}))`;
  const base = 'row-span-3 grid h-8 w-12 place-items-center rounded md:row-span-1';
  if (group === 'content') {
    const ground: CSSProperties =
      token.name === 'inverse-strong' ? { background: 'rgb(var(--color-fill-primary))' } : token.name === 'on-accent' ? { background: 'rgb(var(--color-fill-accent))' } : {};
    return (
      <span className={cx(base, 'border border-stroke-weak text-md font-medium')} style={{ color, ...ground }} aria-hidden>
        Aa
      </span>
    );
  }
  if (group === 'stroke') return <span className={base} style={{ border: `1px solid ${color}` }} aria-hidden />;
  if (token.alpha !== undefined) {
    // A scrim only shows over something: half sand, half night
    const under = 'linear-gradient(90deg, rgb(var(--color-fill-primary)) 50%, rgb(var(--color-background-base)) 50%)';
    return <span className={cx(base, 'border border-stroke-weak')} style={{ background: `linear-gradient(${color}, ${color}), ${under}` }} aria-hidden />;
  }
  return <span className={cx(base, 'border border-stroke-weak')} style={{ background: color }} aria-hidden />;
}

// ── Surfaces & depth ──────────────────────────────────────────────────

function Surfaces() {
  return (
    <Section
      id="surfaces"
      title="Surfaces & depth"
      source="tailwind.config.ts"
      lede="Depth is tonal. A surface gets lighter as it comes forward, an edge is a hairline, and only what floats above the page casts a shadow."
    >
      <SubSection title="The stack">
        <div className="rounded-lg border border-stroke-weak bg-background-base p-4 sm:p-6">
          <SurfaceLabel name="bg-background-base" note="The page" />
          <div className="mt-3 border border-stroke-strong bg-background-sheet p-4 sm:p-6">
            <SurfaceLabel name="bg-background-sheet" note="The side sheet, the ground of the scene" />
            <div className="mt-3 grid items-start gap-5 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
              <div className="rounded-lg border border-stroke-strong bg-background-elevated p-4 sm:p-5">
                <SurfaceLabel name="bg-background-elevated" note="Cards, dialogs, toasts" />
                <div className="mt-3 rounded border border-stroke-strong bg-fill-recessed p-4">
                  <SurfaceLabel name="bg-fill-recessed" note="A well: goes back down to night" />
                </div>
              </div>
              <div className="rounded-md border border-stroke-strong bg-background-popover p-4 shadow-pop">
                <SurfaceLabel name="bg-background-popover" note="Menus and popovers, with shadow-pop" />
              </div>
            </div>
          </div>
        </div>
      </SubSection>

      <SubSection title="Shadows" note="Two, both for things that leave the page plane. Cards and panels take none.">
        <div className="grid gap-5 sm:grid-cols-2">
          <Specimen code="shadow-pop" className="justify-center !py-12">
            <div className="h-20 w-40 rounded-md bg-background-popover shadow-pop" />
          </Specimen>
          <Specimen code="shadow-sheet" className="justify-end !py-12 !pr-0">
            <div className="h-20 w-40 border-l border-stroke-strong bg-background-sheet shadow-sheet" />
          </Specimen>
        </div>
      </SubSection>
    </Section>
  );
}

function SurfaceLabel({ name, note }: { name: string; note: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <code className="font-mono text-xs text-strong">{name}</code>
      <span className="text-xs text-weaker">{note}</span>
    </div>
  );
}

// ── Shape ─────────────────────────────────────────────────────────────

const RADII: Array<{ cls: string; note: string }> = [
  { cls: 'rounded-none', note: 'Scene, sheet, bars' },
  { cls: 'rounded-sm', note: 'Tooltips, segments' },
  { cls: 'rounded', note: 'Buttons, fields, chips' },
  { cls: 'rounded-md', note: 'Menus, inset boxes' },
  { cls: 'rounded-lg', note: 'Cards, dialogs' },
  { cls: 'rounded-full', note: 'Square-cut on purpose' },
  { cls: 'rounded-circle', note: 'The price, and only the price' },
];

function Shape() {
  return (
    <Section
      id="shape"
      title="Shape"
      source="tailwind.config.ts"
      lede="Only the price is round. The sun, the price needle and price points are circles; everything structural is square-cut, with just enough radius to take the edge off."
    >
      <SubSection title="The rule">
        <Specimen className="justify-center gap-x-12 !py-10">
          <Mark size={88} className="text-strong" />
          <p className="max-w-[40ch] text-sm text-weak">
            Two stones are the bounds of the range. The sun between them is the price. In the mark, in a chart and in a control, a circle means the same thing.
          </p>
        </Specimen>
      </SubSection>

      <SubSection title="Radius" note={<>The scale stays small all the way up. <Code>rounded-full</Code> resolves to 2px, so a status dot comes out as a small square; a real circle is <Code>rounded-circle</Code>.</>}>
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4 lg:grid-cols-7">
          {RADII.map((r) => <RadiusTile key={r.cls} {...r} />)}
        </div>
      </SubSection>
    </Section>
  );
}

function RadiusTile({ cls, note }: { cls: string; note: string }) {
  const [ref, [radius]] = useComputed<HTMLDivElement>(['border-top-left-radius']);
  const round = cls === 'rounded-circle';
  return (
    <div className="grid content-start gap-2">
      <div ref={ref} className={cx(cls, 'h-16 w-16 border', round ? 'border-stroke-accent bg-fill-accent/15' : 'border-stroke-strong bg-background-elevated')} />
      <div className="grid gap-0.5">
        <code className="font-mono text-xs text-strong">{cls}</code>
        <span className="font-mono text-2xs text-weaker">{radius?.endsWith('%') ? radius : radius ? `${px(radius)}px` : ''}</span>
        <span className="text-xs text-weaker">{note}</span>
      </div>
    </div>
  );
}

// ── Spacing & layout ──────────────────────────────────────────────────

const SPACES = ['w-1', 'w-1.5', 'w-2', 'w-2.5', 'w-3', 'w-3.5', 'w-4', 'w-5', 'w-6', 'w-7', 'w-10', 'w-12'];

function Spacing() {
  return (
    <Section
      id="spacing"
      title="Spacing & layout"
      source="src/index.css"
      lede="Spacing is Tailwind's 4px scale, untouched. What the system adds is one container and one gutter, shared by the header, every page and the footer."
    >
      <SubSection title="The container" note={<>Class <Code>wrap</Code>: at most 1280px wide, with a side gutter of <Code>clamp(16px, 4vw, 56px)</Code>. A page sets its own width, so a band can still run edge to edge.</>}>
        <div className="overflow-hidden rounded-lg border border-stroke-weak">
          <div className="flex h-28 items-stretch">
            <div className="hatch w-[clamp(16px,4vw,56px)] shrink-0 opacity-40" aria-hidden />
            <div className="grid flex-1 place-items-center border-x border-stroke-strong bg-background-elevated">
              <span className="font-mono text-xs text-weak">max-width 1280px</span>
            </div>
            <div className="hatch w-[clamp(16px,4vw,56px)] shrink-0 opacity-40" aria-hidden />
          </div>
        </div>
      </SubSection>

      <SubSection title="Scale" note="The steps the app leans on. Widths are read off the bar.">
        <div className="grid gap-2">
          {SPACES.map((s) => <SpaceRow key={s} cls={s} />)}
        </div>
      </SubSection>

      <SubSection title="Breakpoints">
        <div className="divide-y divide-stroke-weak border-y border-stroke-weak text-sm">
          {[
            ['sm', '640px', 'The hero scene fills its band; filters sit on one line'],
            ['md', '768px', 'Tables gain their columns; readings hang from one rule'],
            ['lg', '1024px', 'The vault page takes its second column'],
          ].map(([k, v, note]) => (
            <div key={k} className="grid grid-cols-[56px_72px_minmax(0,1fr)] gap-x-4 py-2.5">
              <code className="font-mono text-xs text-strong">{k}:</code>
              <span className="num font-mono text-xs text-weaker">{v}</span>
              <span className="text-weak">{note}</span>
            </div>
          ))}
        </div>
      </SubSection>
    </Section>
  );
}

function SpaceRow({ cls }: { cls: string }) {
  const [ref, [width]] = useComputed<HTMLDivElement>(['width']);
  return (
    <div className="flex items-center gap-4">
      <code className="w-12 shrink-0 font-mono text-xs text-strong">{cls.replace('w-', '')}</code>
      <span className="num w-10 shrink-0 font-mono text-xs text-weaker">{width ? `${px(width)}px` : ''}</span>
      <div ref={ref} className={cx(cls, 'h-3 bg-strong')} />
    </div>
  );
}

// ── Motion ────────────────────────────────────────────────────────────

function Motion() {
  const [moved, setMoved] = useState(false);
  const [run, setRun] = useState(0);
  return (
    <Section
      id="motion"
      title="Motion"
      source="tailwind.config.ts"
      lede="Motion explains a change of state and then stops. One easing curve is shared by the interface and the scene, so a button and the sun move with the same hand."
    >
      <SubSection title="Easing" note={<><Code>ease-dusk</Code> is <Code>cubic-bezier(0.65, 0, 0.35, 1)</Code>: a slow start, a slow arrival. Below, the price moves along the scale with it, then without it.</>}>
        <Specimen className="!block">
          <div className="grid gap-6">
            {[{ label: 'ease-dusk', cls: 'ease-dusk' }, { label: 'linear', cls: 'ease-linear' }].map((e) => (
              <div key={e.label} className="grid gap-2">
                <code className="font-mono text-xs text-weaker">{e.label}</code>
                <div className="relative pt-4">
                  <div className={cx('absolute inset-x-0 top-0 transition-transform duration-700', e.cls, moved && 'translate-x-[calc(100%-14px)]')}>
                    <div className="h-3.5 w-3.5 rounded-circle bg-accent" />
                  </div>
                  <div className="ruler" aria-hidden />
                </div>
              </div>
            ))}
            <div><Button size="sm" variant="secondary" onClick={() => setMoved((v) => !v)}>Move the price</Button></div>
          </div>
        </Specimen>
      </SubSection>

      <SubSection title="Durations">
        <div className="divide-y divide-stroke-weak border-y border-stroke-weak text-sm">
          {[
            ['150ms', 'duration-150', 'A small flip: the toggle knob, a chevron'],
            ['160ms', 'animate-fade-in', 'Something appearing in place: popover, toast, dialog'],
            ['300ms', 'duration-300 ease-dusk', 'A colour change on a control: buttons, vault rows'],
            ['450ms', 'animate-slide-in', 'The side sheet arriving from the right'],
            ['2s', 'animate-rise', 'The loader: the sun rising and setting between the stones'],
          ].map(([t, cls, note]) => (
            <div key={cls} className="grid grid-cols-[56px_minmax(0,1fr)] gap-x-4 gap-y-0.5 py-2.5 md:grid-cols-[56px_200px_minmax(0,1fr)]">
              <span className="num font-mono text-xs text-strong">{t}</span>
              <code className="font-mono text-xs text-weaker">{cls}</code>
              <span className="col-start-2 text-weak md:col-start-3">{note}</span>
            </div>
          ))}
        </div>
      </SubSection>

      <SubSection title="Animations">
        <Specimen>
          <div key={run} className="flex flex-wrap items-center gap-x-10 gap-y-6">
            <AnimationTile label="animate-fade-in"><div className="h-14 w-24 animate-fade-in rounded-md border border-stroke-strong bg-background-popover" /></AnimationTile>
            <AnimationTile label="animate-slide-in"><div className="h-14 w-24 animate-slide-in border-l border-stroke-strong bg-background-sheet" /></AnimationTile>
            <AnimationTile label="animate-rise"><MarkLoader className="h-9 w-[58px] text-strong" /></AnimationTile>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setRun((n) => n + 1)}>Replay</Button>
        </Specimen>
      </SubSection>

      <SubSection title="Reduced motion">
        <p className="max-w-[64ch] text-sm text-weak">
          With <Code>prefers-reduced-motion</Code> every transition and animation is cut to an instant by one rule in <Code>src/index.css</Code>. Nothing depends on motion to be understood: a state that animates in is also complete when it is still.
        </p>
      </SubSection>
    </Section>
  );
}

function AnimationTile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid justify-items-start gap-2.5">
      <div className="grid h-14 items-center overflow-hidden">{children}</div>
      <code className="font-mono text-xs text-weaker">{label}</code>
    </div>
  );
}

// ── Marks & textures ──────────────────────────────────────────────────

function Marks() {
  return (
    <Section
      id="marks"
      title="Marks & textures"
      source="src/components/brand/Mark.tsx · src/index.css"
      lede="The few drawn things the interface owns. Each one stands for something, so none of them is used as decoration."
    >
      <SubSection title="The mark" note="Two stones on a horizon with the sun setting between them. It takes the text colour; the sun keeps its own.">
        <Specimen align="end" className="gap-x-10">
          {[16, 24, 40, 64].map((s) => (
            <div key={s} className="grid justify-items-start gap-2.5">
              <Mark size={s} className="text-strong" />
              <span className="num font-mono text-xs text-weaker">{s}px</span>
            </div>
          ))}
          <div className="grid justify-items-start gap-2.5">
            <span className="flex items-center gap-3 text-strong"><Mark size={24} /><span className="wordmark">{BRAND.name}</span></span>
            <span className="font-mono text-xs text-weaker">with the wordmark</span>
          </div>
        </Specimen>
      </SubSection>

      <SubSection title="Ruler" note={<>Class <Code>ruler</Code>: an engraved scale. Readings hang from it, and a price moves along it.</>}>
        <Specimen className="!block"><div className="ruler" /></Specimen>
      </SubSection>

      <SubSection title="Hatch" note={<>Class <Code>hatch</Code>: the part that is given up. In the claim sheet it is the half forfeited by claiming early.</>}>
        <Specimen className="!block">
          <div className="grid max-w-[420px] gap-2">
            <div className="flex h-2">
              <i className="block h-full w-1/2 bg-strong" />
              <i className="hatch block h-full flex-1" />
            </div>
            <div className="flex justify-between text-xs"><span className="text-strong">Received now</span><span className="text-weaker">Forfeited</span></div>
          </div>
        </Specimen>
      </SubSection>
    </Section>
  );
}

// ── Layering ──────────────────────────────────────────────────────────

function Layering() {
  return (
    <Section
      id="layering"
      title="Layering"
      lede="The stacking order as the app uses it today. The values are Tailwind's own and are not named yet; a new layer takes its place in this order rather than a larger number."
    >
      <div className="divide-y divide-stroke-weak border-y border-stroke-weak text-sm">
        {[
          ['z-[70]', 'Modal', 'A dialog and its scrim'],
          ['z-50', 'Toast, sheets', 'Toasts; the deposit and claim sheets'],
          ['z-40', 'Popover', 'Menus, popovers, tooltips'],
          ['z-30', 'Header', 'The sticky header'],
          ['z-20', 'Badge', 'The chain mark on a token pair'],
          ['z-[2] · z-[4]', 'Hero', 'The shade over the scene, then the text over the shade'],
        ].map(([z, name, note]) => (
          <div key={z} className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-4 gap-y-0.5 py-2.5 md:grid-cols-[110px_140px_minmax(0,1fr)]">
            <code className="num font-mono text-xs text-strong">{z}</code>
            <span className="text-strong">{name}</span>
            <span className="col-start-2 text-weak md:col-start-3">{note}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ── Focus ─────────────────────────────────────────────────────────────

function Focus() {
  return (
    <Section
      id="focus"
      title="Focus"
      source="src/index.css"
      lede={<>Keyboard focus is a 2px outline in <Code>stroke-focused</Code>, set 3px off the control. It is the sun: the one thing on screen you are pointing at.</>}
    >
      <Specimen code="button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid; outline-offset: 3px }">
        <Button size="sm">Deposit</Button>
        <Button size="sm" variant="secondary">Withdraw</Button>
        <a href="#focus" className="text-sm text-accent underline underline-offset-[3px] hover:text-accent-bright">A text link</a>
        <input aria-label="Example field" placeholder="A field" className="h-9 w-40 rounded border border-stroke-strong bg-fill-recessed px-3 text-sm text-strong outline-none placeholder:text-weaker" />
        <span className="text-xs text-weaker">Press Tab to move through these.</span>
      </Specimen>
    </Section>
  );
}
