# Design system reference

> Source of truth for colour: `src/lib/tokens.ts`. Everything else (type, radius, shadows, motion) lives in
> `tailwind.config.ts` and the utility classes in `src/index.css`.
>
> The live gallery is at `/design-system` when the app is running. It renders the real components, so it
> shows what the app does; this file says what to write.

This is the Dusk direction: a dark ground, sand type, one amber for the price. It is dark only.

---

## Core rule

**Every component uses semantic classes. A hardcoded colour is a bug.**

- Not allowed: `bg-[#2A1B20]`, `text-[rgb(239_227_209)]`, any arbitrary colour value
- Not possible: `text-sand-700`, `bg-plum-800`. Base colours have no utility class
- Correct: `bg-background-elevated`, `text-weak`, `border-stroke-strong`
- Correct: `bg-fill-error/10`, `border-stroke-error/40` (opacity as a modifier on a semantic token)

If the role you need does not exist, add a token (see [Adding a colour](#adding-a-colour)). Do not reach
around the system.

---

## Colour architecture

Colour comes in two layers, both declared in `src/lib/tokens.ts`.

1. **Primitives** are the palette: `plum-950`, `sand-1000`, `sun-1000`. They are named by ramp and
   level and say nothing about use.
2. **Semantic tokens** are roles: `strong`, `fill-weak`, `stroke-weak`. Each one points at exactly one
   primitive.

`tailwind.config.ts` reads that file and does two things. Its plugin writes both layers to `:root` as CSS
variables (`--color-sand-1000: 239 227 209`, `--color-strong: var(--color-sand-1000)`). Its `colors` map
contains the semantic names only, so only semantic names become utilities. That is what enforces the
core rule: there is nothing to type that reaches a primitive.

Values are RGB triplets so Tailwind's opacity modifiers work.

To change what a role looks like, change the `ref` of its token. No component is touched.

### Primitives

| Token | Value | What it is |
|---|---|---|
| `plum-950` | `#150D10` | Night |
| `plum-900` | `#1F1418` | Dusk |
| `plum-800` | `#2A1B20` | Raised dusk |
| `plum-700` | `#36242A` | High dusk |
| `sand-bright` | `#FFF6E8` | Sand, lit |
| `sand-1000` | `#EFE3D1` | Sand |
| `sand-700` | `#C4B19D` | Sand 2 |
| `sand-500` | `#9C8878` | Sand 3 |
| `sand-240` | `#49403E` | Sand at 24% on night |
| `sand-120` | `#2F2727` | Sand at 12% on night |
| `sun-bright` | `#FFE3A3` | Sun core |
| `sun-1000` | `#FFAE3D` | Sun |
| `sun-ink` | `#2A1606` | Ink on sun |
| `green-1000` | `#92D6A6` | Gain |
| `red-1000` | `#FF8A8F` | Loss |
| `tan-1000` | `#E0B07A` | Caution |
| `rose-1000` | `#B36D5F` | Rose |
| `black` | `#000000` | Black |

Plum is the ground and gets darker as the number rises. Sand is everything written or ruled; `240` and
`120` are sand at 24% and 12% over night, kept as solid colours so a hairline looks the same on any
surface. The tan is dull on purpose, so caution is never mistaken for the sun.

### Which family a class takes

The utility picks the family.

| You are painting | Family | Example |
|---|---|---|
| Text, an icon | content | `text-weak` |
| The surface something sits on | background | `bg-background-elevated` |
| An area inside a surface: a control, a chip, a well, a tint | fill | `bg-fill-weak` |
| A border, divider, ring | stroke | `border-stroke-strong`, `divide-stroke-weak` |
| A mark drawn like ink: a tick, an indicator rule, a status dot, a legend swatch, an SVG shape | content | `after:bg-strong`, `fill-weaker`, `bg-success` |
| A hairline drawn as a shape | stroke | `fill-stroke-strong`, `bg-stroke-strong` |

---

## Text colours

| Class | Points at | Use |
|---|---|---|
| `text-strong` | `sand-1000` | Readings, titles, primary text |
| `text-weak` | `sand-700` | Supporting text, labels beside a value |
| `text-weaker` | `sand-500` | Eyebrows, hints, placeholders, axis ticks |
| `text-disabled` | `sand-500` | Text on a disabled control |
| `text-inverse-strong` | `plum-950` | Text on a sand fill: primary button, tooltip, selected segment |
| `text-on-accent` | `sun-ink` | Text on a sun fill |
| `text-accent` | `sun-1000` | The price, reward amounts, text links |
| `text-accent-bright` | `sun-bright` | Price readout, hovered text link |
| `text-success` | `green-1000` | Gain, in range, confirmed |
| `text-error` | `red-1000` | Loss, out of range, failed |
| `text-warning` | `tan-1000` | Caution, demo data, paused |

`--color-chart-secondary` (`rose-1000`) is a CSS variable only: a chart series with no meaning of its
own, read through `usePalette()`.

**The sun means price.** `accent` is the price and the reward that follows it, nothing else. Gain and
loss have their own colours and always come with words or a sign, never colour alone.

## Background colours

| Class | Points at | Use |
|---|---|---|
| `bg-background-base` | `plum-950` | The page, the header |
| `bg-background-sheet` | `plum-900` | Side sheet, scene ground |
| `bg-background-elevated` | `plum-800` | Cards, dialogs, toasts |
| `bg-background-popover` | `plum-700` | Menus and popovers |

Depth is tonal: a surface gets lighter as it comes forward.

## Fill colours

| Class | Points at | Use |
|---|---|---|
| `bg-fill-recessed` | `plum-950` | Wells: amount fields, inset boxes inside a card |
| `bg-fill-weak` | `plum-700` | Chips, pills, token tiles |
| `bg-fill-hover` | `plum-700` | Hover on a control with no fill of its own |
| `bg-fill-selected` | `plum-700` | The chosen chip |
| `bg-fill-disabled` | `plum-700` | A disabled filled button |
| `bg-fill-track` | `sand-120` | Switch off, progress and slider tracks |
| `bg-fill-primary` | `sand-1000` | Primary action, selected segment, switch on |
| `bg-fill-primary-hover` | `sand-bright` | Primary action, hovered |
| `bg-fill-primary-shade` | `sand-700` | The body of a primary key, under its highlight |
| `bg-fill-accent` | `sun-1000` | Reward action, reward switch on |
| `bg-fill-accent-hover` | `sun-bright` | Reward action, hovered |
| `bg-fill-inverse` | `sand-1000` | Tooltips |
| `bg-fill-success` | `green-1000` | Success tint (use `/10`) |
| `bg-fill-error` | `red-1000` | Error tint (use `/10`) |
| `bg-fill-warning` | `tan-1000` | Warning tint (use `/10`) |
| `bg-fill-overlay` | `black` at 60% | Scrim behind a dialog or sheet |

`fill-overlay` carries its own opacity, so it takes no modifier. `--color-fill-selection` (`rose-1000`) is a
CSS variable only, used for `::selection` at 35%.

The keys (see [Keys, glass and wells](#keys-glass-and-wells)) read `fill-primary-shade`, `fill-primary-hover`,
`fill-accent`, `fill-accent-hover` and `fill-disabled` as CSS variables in `index.css`, not as classes.

Several fills share one value today (`fill-weak`, `fill-hover`, `fill-selected`, `fill-disabled`). They are
separate tokens because they are separate roles; pick by role, not by what looks the same.

## Border colours

| Class | Points at | Use |
|---|---|---|
| `border-stroke-weak` | `sand-120` | Dividers, quiet edges. The default border colour |
| `border-stroke-strong` | `sand-240` | Card edges, control boundaries, rulers |
| `border-stroke-stronger` | `sand-500` | A boundary on hover |
| `border-stroke-strongest` | `sand-700` | An outlined button on hover |
| `border-stroke-selected` | `sand-1000` | The chosen tab, chip or step |
| `border-stroke-focused` | `sun-1000` | Keyboard focus ring, the focused amount field |
| `border-stroke-primary` | `sand-1000` | Edge of a primary fill |
| `border-stroke-primary-hover` | `sand-bright` | Edge of a primary fill, hovered |
| `border-stroke-accent` | `sun-1000` | Edge of an accent fill, the chosen reward option |
| `border-stroke-accent-hover` | `sun-bright` | Edge of an accent fill, hovered |
| `border-stroke-success` | `green-1000` | Success edge (use `/40`) |
| `border-stroke-error` | `red-1000` | Error edge (use `/40`), invalid field |
| `border-stroke-warning` | `tan-1000` | Warning edge (use `/40`) |

The four neutral steps are named by weight, not by state, because the same weight serves hover in one
place and rest in another. `border` with no colour class resolves to `stroke-weak`.

### Chart colours

Chart libraries cannot read CSS variables, so `usePalette()` in `src/lib/theme.ts` hands them hex values
derived from the same tokens. Never type a hex into a chart.

```ts
const pal = usePalette();
<CartesianGrid stroke={pal.strokeWeak} />
<Area stroke={pal.strong} />
```

---

## Typography

| Class | Face | Use |
|---|---|---|
| `font-serif` | Zodiak | Page titles and vault names. Thin (100) at the largest sizes, light (300) below, never bold |
| `font-sans` | Geist | Everything read or operated |
| `font-display` | Geist | Same stack as `font-sans`; names the emphasis role |
| `font-mono` | Geist Mono | Addresses, hashes, code |

**Figures.** A face named "Switzer Figures" leads both sans stacks. Its `unicode-range` covers only the
digits and `$ % + , . −`, so every figure is set in Switzer and every letter in Geist, with no class.
Figures are tabular everywhere (`body` sets `tnum`); `num` restates it where needed.

**Fonts are served from CDNs.** Zodiak and Switzer come from Fontshare; their licence does not allow
the files in a public repository. Do not commit them.

### Role classes (`src/index.css`)

| Class | What it is |
|---|---|
| `title` | Page-level title: serif, light, tight. Add `font-thin` for the title a page opens with |
| `display` | UI title: Geist medium |
| `display num` | A reading: one weight lighter than a title |
| `eyebrow` | The small caps label that names a reading |
| `wordmark` | The name in the header |
| `wrap` | The page container (see [Layout](#layout)) |
| `ruler` | An engraved scale that readings hang from |
| `hatch` | Diagonal hatching: the part that is given up |

### Sizes

| Class | Size / line | Use |
|---|---|---|
| `text-2xs` | 11 / 14 | Eyebrows, badges |
| `text-xs` | 12 / 16 | Captions, hints, chart ticks |
| `text-sm` | 13 / 18 | Supporting text, compact buttons |
| `text-base` | 14 / 20 | Body, the default button |
| `text-md` | 15 / 22 | Large button, dialog title |
| `text-lg` | 17 / 24 | Amount being typed |
| `text-xl` | 20 / 26 | Sub-headings |
| `text-2xl` | 24 / 30 | Section titles |
| `text-3xl` | 30 / 36 | A large reading |
| `text-4xl` | 38 / 44 | The reading a page is about |

### Weights

`font-thin` 100, `font-light` 300, `font-normal` 400, `font-medium` 500, `font-semibold` 500,
`font-bold` 600. Geist carries emphasis at 500, so `semibold` is mapped to it; 600 is the ceiling.

---

## Shape

**Only the price is round.** The sun, the price needle and price points are circles. Everything
structural (ranges, controls, cards, token tiles) is square-cut.

| Class | Radius | Use |
|---|---|---|
| `rounded-none` | 0 | Scene, sheet, bars |
| `rounded-sm` | 2px | Tooltips, segments |
| `rounded` / `rounded-md` | 3px | Buttons, fields, chips, menus |
| `rounded-lg` | 4px | Cards, dialogs |
| `rounded-full` | 2px | Square-cut on purpose: a status dot is a small square |
| `rounded-circle` | 50% | A real circle. The price only |

Keys and wells set their own radius in `index.css`, outside this scale:

| Class | Radius |
|---|---|
| `btn` | 10px (`--btn-radius`); 8px at Button size `xs` |
| `seg` | 8px (`--seg-radius`) |
| `well` | 11px (`--well-radius`) |
| `groove` | The well's radius less its 3px padding, for the key inside it |

This departs from the square-cut rule; see [Known inconsistencies](#known-inconsistencies).

## Shadows

Depth comes from tone and hairlines. Only what leaves the page plane casts a shadow.

| Class | Use |
|---|---|
| `shadow-pop` | Menus, popovers, dialogs, toasts |
| `shadow-sheet` | The side sheet |
| `shadow-well` | A recess cut into a surface: shade under its top edge, the bottom rim catching the light. Applied by `well` |

Cards and panels take none. Keys and glass carry their own stacks of shadows in `index.css`
(`btn-key`, `btn-glass`, `seg-thumb-key`); they are part of the material, not tokens.

## Motion

| Class | Timing | Use |
|---|---|---|
| `ease-dusk` | `cubic-bezier(0.65, 0, 0.35, 1)` | The one easing curve, shared with the scene |
| `duration-150` | 150ms | A small flip: the toggle knob, a chevron |
| `animate-fade-in` | 160ms | Something appearing in place: popover, toast, dialog |
| `duration-300 ease-dusk` | 300ms | A colour change on a control; a key's light and shadow; the sliding key moving to a new choice; the spinner slot opening in a button |
| `animate-[vault-tab-in_200ms_ease-out]` | 200ms | The deposit card's form fading in when Deposit and Withdraw switch |
| `animate-slide-in` | 450ms | The side sheet arriving |
| `animate-rise` | 2s, alternating | The loader |

`prefers-reduced-motion` cuts every transition and animation to an instant (one rule in `index.css`).
Nothing may depend on motion to be understood.

## Layering

Not named yet; these are the values in use. A new layer takes its place in this order.

| Value | Layer |
|---|---|
| `z-[70]` | Modal and its scrim |
| `z-50` | Toasts; the deposit and claim sheets |
| `z-40` | Menus, popovers, tooltips |
| `z-30` | The sticky header |
| `z-20` | The chain mark on a token pair |

## Layout

- `wrap` is the page container: at most 1280px, with a side gutter of `clamp(16px, 4vw, 56px)`. The
  header, every page and the footer use it. A page sets its own width, so a band can run edge to edge.
- Spacing is Tailwind's 4px scale, untouched.
- Breakpoints in use: `sm` 640px, `md` 768px, `lg` 1024px.

## Focus

Keyboard focus is a 2px outline in `stroke-focused`, offset 3px, on every button, link and input
(`index.css`). Do not remove it. A field that wraps its input shows focus on its own edge with
`focus-within:border-stroke-focused`. A `well` has no border, so it rings itself instead:
`ring-inset focus-within:ring-1 focus-within:ring-stroke-focused`.

---

## Keys, glass and wells

Controls are made of three materials, all defined in the `components` layer of `src/index.css`. A
component picks a material by class; the colours come from tokens.

| Class | What it is |
|---|---|
| `btn` | The shared base of every Button: radius, timing, the 1px press on `:active` |
| `btn-key` | A lit keycap: a darker body, a highlight across its top half, light gathering along the bottom edge and spilling onto the ground beneath. Needs a colour class |
| `btn-key-primary` | The sand key: body `fill-primary-shade`, light `fill-primary-hover` |
| `btn-key-accent` | The sun key: body `fill-accent`, light `fill-accent-hover` |
| `btn-glass` | Dark glass: a 5% tint of `--glass` (default `strong`) with a lit top edge |
| `btn-glass-danger` | Glass in `error` |
| `btn-glass-warning` | Glass in `warning`. The header's network and wallet buttons add it when the wallet is on the wrong network |
| `seg` | A glass track for a segmented control |
| `seg-thumb` + `seg-thumb-key` | The sand key that sits under the chosen segment of a `seg` |
| `seg-thumb` + `seg-thumb-glass` | The same key in glass, opaque underneath so it reads the same over anything |
| `well` | A recess cut into a surface: `fill-recessed` at 60% with `shadow-well`. The field an amount is typed into |
| `groove` | A `well` that holds a choice: the options sit in the recess and the chosen one is raised out of it as a glass key |

Every state of a key is the same stack of shadows in the same order, so a state change only fades layers
in and out. A state that drops a layer keeps it at zero alpha. Keep that order when adding a state, or
one layer will morph into another.

A key's label does not fade: going between disabled and enabled it would pass through the body's own
colour. It changes at once, partway through the body's transition (`--label-delay`).

---

## Button

`src/components/ui/Button.tsx`

| Variant | Material | Label | Hover | Disabled | Use |
|---|---|---|---|---|---|
| `primary` | `btn-key btn-key-primary` | `text-inverse-strong` | The light beneath spreads | Body `fill-disabled`, a `stroke-strong` edge, no light; label `text-disabled` | The standard action |
| `accent` | `btn-key btn-key-accent` | `text-on-accent` | The light beneath spreads | As primary | Reward actions, the opening call to action. One in view |
| `secondary` | `btn-glass` | `text-strong` | Tint 5% → 10%, edge brighter | Transparent, a `stroke-strong` edge; label `text-disabled` | The other action beside a primary one; the header's network and wallet buttons |
| `ghost` | None | `text-weak` | `bg-fill-hover text-strong` | `text-disabled` | Stepping back inside a panel or dialog |
| `danger` | `btn-glass btn-glass-danger` | `text-error` | As secondary, in `error` | As secondary, but the label stays `text-error` | Destructive, irreversible |

All variants press 1px down on `:active`. For a warning state on a secondary button, add
`btn-glass-warning` through `className`.

| Size | Class | Height | Use |
|---|---|---|---|
| `xs` | `h-7 px-2.5 text-xs`, radius 8px | 28px | Inside a panel header (the price range's flip control) |
| `sm` | `h-9 px-3 text-sm` | 36px | The header, rows |
| `md` | `h-11 px-[18px] text-base` | 44px (default) | |
| `lg` | `h-12 px-5 text-md` | 48px | |

`loading` disables the button and opens a slot before the label for the spinner, so the button widens
instead of jumping; the label stays. When loading ends the slot closes and the spinner fades out with
it. Use it for one button's own submit instead of placing a `Spinner` by hand.

## Segmented and SlidingKey

`src/components/ui/Tabs.tsx`, `src/components/ui/SlidingKey.tsx`

`Segmented` is a `seg` glass track with one sand key on it. The key is a single element, `SlidingKey`,
that measures the chosen item and slides there (300ms, `ease-dusk`) when the choice changes. Its first
placement is not animated. It re-measures after every render and when the track resizes, so a label
changing width keeps it in place.

`SlidingKey` can be used on any track that has relative positioning and is a `seg` or a `groove`:

```tsx
const track = useRef<HTMLDivElement>(null);
<div ref={track} className="well groove grid">
  <SlidingKey track={track} chosen='[aria-pressed="true"]' tone="glass" />
  {options.map((o) => <button aria-pressed={value === o.id} … />)}
</div>
```

| Prop | Type | What it does |
|---|---|---|
| `track` | `RefObject<HTMLElement>` | The track the key is rendered inside |
| `chosen` | `string` | A selector for the chosen item inside the track, e.g. `[aria-selected="true"]` |
| `tone` | `'key' \| 'glass'` | `key` (default) is the lit sand key; `glass` is the secondary button's material |

Render it as the track's first child, before the options. The options carry the label colour
(`text-inverse-strong` on a sand key, `text-strong` on glass); the key draws nothing but itself.

The deposit card's token choice is the `groove` + `glass` form: equal columns, so three or four
options share one row.

## Component inventory

Base components in `src/components/ui/`, as of 2026-10-05. "In use" means the app renders it somewhere
outside the gallery.

| Component | File | In use |
|---|---|---|
| Button | `Button.tsx` | Yes |
| AmountInput | `AmountInput.tsx` | No. The deposit card draws its own field |
| Toggle | `Toggle.tsx` | No |
| Segmented | `Tabs.tsx` | Yes |
| SlidingKey | `SlidingKey.tsx` | Yes, inside Segmented and the deposit card's token choice. No gallery section of its own |
| UnderlineTabs | `Tabs.tsx` | No |
| ChainFilter | `ChainFilter.tsx` | Yes, but draws nothing while there is one chain |
| Card | `Card.tsx` | Yes |
| Stat, StatRow | `Stat.tsx` | Yes |
| KV | `KeyValue.tsx` | No |
| TierBadge, RangeStatusBadge | `Badge.tsx` | No |
| Pill | `Badge.tsx` | Yes |
| DemoBadge, LiveBadge, DataLegend | `DataBadge.tsx` | Yes |
| TokenIcon, TokenPair | `TokenIcon.tsx` | Yes |
| ChainLogo | `ChainLogo.tsx` | Yes, through TokenPair |
| BoostedApr | `BoostedApr.tsx` | Yes |
| Collapsible | `Collapsible.tsx` | No |
| Tooltip, InfoDot | `Tooltip.tsx` | Yes |
| ToastHost | `Toast.tsx` | Yes |
| Spinner | `Spinner.tsx` | Yes |
| Modal | `Modal.tsx` | Yes |

Tone and variant props use the semantic names: `accent`, `success`, `error`, `warning`, `primary`.

---

## Adding a colour

1. If the value is new, add a primitive to `PRIMITIVES` in `src/lib/tokens.ts`, on the ramp it belongs to.
2. Add a semantic token to the right group in `SEMANTIC_GROUPS`, with its `ref` and a one-line `use`.
   The CSS variable, the utility class and the swatch in the gallery all follow from that entry.
3. Restart the dev server. The Tailwind config is read once, at start.
4. Add the row to the table in this file.

To tint, use an opacity modifier on an existing token (`bg-fill-success/10`) before adding a new one.

## Known inconsistencies

Carried over as they were, so that moving to semantic tokens changed no pixel. Each is a decision to make,
not a bug in the token layer.

- **Field focus is shown four ways.** The deposit card's amount field (a `well`) rings itself in
  `stroke-focused` (sun). `AmountInput` uses `stroke-stronger`, the live amount input and the local dev
  field use `stroke-strong`, and the vault search uses `stroke-strongest`. One of these should be the rule.
- **A disabled `danger` button keeps its red label.** The glass drops to the plain disabled edge, but the
  label stays `text-error` where every other variant turns `text-disabled`.
- **Keys and wells are rounded.** Buttons (10px, 8px at `xs`), segmented tracks (8px) and wells (11px)
  set their radius in `index.css`, outside the radius scale and against "everything structural is
  square-cut". Cards, chips and menus are still 3–4px.
- **Tokens the keys left behind.** Since buttons and segments became keys, `stroke-primary-hover`,
  `stroke-accent-hover` and `fill-selected` are used by no component. `fill-primary`'s use still reads
  "primary action, selected segment", but those are now drawn from `fill-primary-shade` and
  `fill-primary-hover`; `fill-primary` remains for the switch, the slider thumb and the live page.
- **Error edges use three opacities** (`/40`, `/60`, `/70`) for the same role.
- **Layering is unnamed.** `z-40`, `z-50`, `z-[70]` are raw values.
- **Illustration colours are literals.** The 3D scene and the price range drawing (`PriceRange.tsx`,
  `Scene.tsx`, `duskScene.ts`) carry their own hex values for stone, sky and light. They are artwork,
  not interface tokens, and are outside this system for now.
