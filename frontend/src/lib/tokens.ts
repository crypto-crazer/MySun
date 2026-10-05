/**
 * Colour tokens, in two layers. This file is the single source:
 *  - tailwind.config.ts turns it into CSS variables and into the colour utilities,
 *  - lib/theme.ts into hex values for chart libraries,
 *  - /design-system into the swatches, and docs/design-system.md describes the rules.
 *
 * 1. Primitives: the Dusk palette, named by ramp and level. A component never names one.
 * 2. Semantic tokens: named by role, each pointing at one primitive. Only these become Tailwind
 *    colours, so only these can be reached from a class.
 *
 * Dusk is dark only, so there is one set of values.
 */

export interface Primitive {
  /** RGB triplet, kept apart so Tailwind opacity modifiers work (`bg-fill-error/10`). */
  rgb: readonly [number, number, number];
  note: string;
}

export const PRIMITIVES = {
  // Plum: the ground. Higher numbers are darker.
  'plum-950': { rgb: [21, 13, 16], note: 'Night' },
  'plum-900': { rgb: [31, 20, 24], note: 'Dusk' },
  'plum-800': { rgb: [42, 27, 32], note: 'Raised dusk' },
  'plum-700': { rgb: [54, 36, 42], note: 'High dusk' },
  // Sand: everything written or ruled. 240 and 120 are sand at 24% and 12% over night, kept solid.
  'sand-bright': { rgb: [255, 246, 232], note: 'Sand, lit' },
  'sand-1000': { rgb: [239, 227, 209], note: 'Sand' },
  'sand-700': { rgb: [196, 177, 157], note: 'Sand 2' },
  'sand-500': { rgb: [156, 136, 120], note: 'Sand 3' },
  'sand-240': { rgb: [73, 64, 62], note: 'Sand at 24% on night' },
  'sand-120': { rgb: [47, 39, 39], note: 'Sand at 12% on night' },
  // Sun: the price, and the reward that follows it. Nothing structural.
  'sun-bright': { rgb: [255, 227, 163], note: 'Sun core' },
  'sun-1000': { rgb: [255, 174, 61], note: 'Sun' },
  'sun-ink': { rgb: [42, 22, 6], note: 'Ink on sun' },
  // Outcomes and caution. The tan is dull on purpose, so it is never mistaken for the sun.
  'green-1000': { rgb: [146, 214, 166], note: 'Gain' },
  'red-1000': { rgb: [255, 138, 143], note: 'Loss' },
  'tan-1000': { rgb: [224, 176, 122], note: 'Caution' },
  'rose-1000': { rgb: [179, 109, 95], note: 'Rose' },
  black: { rgb: [0, 0, 0], note: 'Black' },
} as const satisfies Record<string, Primitive>;

export type PrimitiveName = keyof typeof PRIMITIVES;

export interface SemanticToken {
  name: string;
  ref: PrimitiveName;
  /** Opacity that is part of the token. A token with one takes no opacity modifier. */
  alpha?: number;
  /** Declared as a CSS variable only: used by index.css, not exposed as a utility. */
  cssOnly?: boolean;
  use: string;
}

export interface SemanticGroup {
  id: 'content' | 'background' | 'fill' | 'stroke';
  title: string;
  /** Which utilities take this family. */
  utilities: string;
  note: string;
  tokens: SemanticToken[];
}

export const SEMANTIC_GROUPS: SemanticGroup[] = [
  {
    id: 'content',
    title: 'Content',
    utilities: 'text-*, and bg-* / fill-* / border-* for a mark drawn like ink',
    note: 'Text, icons and anything drawn in the text colour: ticks, indicator rules, status dots, legend swatches, SVG shapes.',
    tokens: [
      { name: 'strong', ref: 'sand-1000', use: 'Readings, titles, primary text' },
      { name: 'weak', ref: 'sand-700', use: 'Supporting text, labels beside a value' },
      { name: 'weaker', ref: 'sand-500', use: 'Eyebrows, hints, placeholders, axis ticks' },
      { name: 'disabled', ref: 'sand-500', use: 'Text on a disabled control' },
      { name: 'inverse-strong', ref: 'plum-950', use: 'Text on a sand fill: primary button, tooltip, selected segment' },
      { name: 'on-accent', ref: 'sun-ink', use: 'Text on a sun fill' },
      { name: 'accent', ref: 'sun-1000', use: 'The price, reward amounts, text links' },
      { name: 'accent-bright', ref: 'sun-bright', use: 'Price readout, hovered text link' },
      { name: 'success', ref: 'green-1000', use: 'Gain, in range, confirmed' },
      { name: 'error', ref: 'red-1000', use: 'Loss, out of range, failed' },
      { name: 'warning', ref: 'tan-1000', use: 'Caution, demo data, paused' },
      { name: 'chart-secondary', ref: 'rose-1000', cssOnly: true, use: 'A chart series with no meaning of its own (volume bars)' },
    ],
  },
  {
    id: 'background',
    title: 'Background',
    utilities: 'bg-background-*',
    note: 'The four surfaces something can sit on. Depth is tonal: a surface gets lighter as it comes forward, and none of them carries a shadow except the popover.',
    tokens: [
      { name: 'background-base', ref: 'plum-950', use: 'The page, the header' },
      { name: 'background-sheet', ref: 'plum-900', use: 'Side sheet, scene ground' },
      { name: 'background-elevated', ref: 'plum-800', use: 'Cards, dialogs, toasts' },
      { name: 'background-popover', ref: 'plum-700', use: 'Menus and popovers' },
    ],
  },
  {
    id: 'fill',
    title: 'Fill',
    utilities: 'bg-fill-*',
    note: 'An area inside a surface: a control, a chip, a well, a tint. Status fills are meant to be tinted with an opacity modifier.',
    tokens: [
      { name: 'fill-recessed', ref: 'plum-950', use: 'Wells: amount fields, inset boxes inside a card' },
      { name: 'fill-weak', ref: 'plum-700', use: 'Chips, pills, token tiles' },
      { name: 'fill-hover', ref: 'plum-700', use: 'Hover on a control with no fill of its own' },
      { name: 'fill-selected', ref: 'plum-700', use: 'The chosen chip' },
      { name: 'fill-disabled', ref: 'plum-700', use: 'A disabled filled button' },
      { name: 'fill-track', ref: 'sand-120', use: 'Switch off, progress and slider tracks' },
      { name: 'fill-primary', ref: 'sand-1000', use: 'Primary action, selected segment, switch on' },
      { name: 'fill-primary-hover', ref: 'sand-bright', use: 'Primary action, hovered' },
      { name: 'fill-primary-shade', ref: 'sand-700', use: 'The body of a primary key, under its highlight' },
      { name: 'fill-accent', ref: 'sun-1000', use: 'Reward action, reward switch on' },
      { name: 'fill-accent-hover', ref: 'sun-bright', use: 'Reward action, hovered' },
      { name: 'fill-inverse', ref: 'sand-1000', use: 'Tooltips' },
      { name: 'fill-success', ref: 'green-1000', use: 'Success tint (use /10)' },
      { name: 'fill-error', ref: 'red-1000', use: 'Error tint (use /10)' },
      { name: 'fill-warning', ref: 'tan-1000', use: 'Warning tint (use /10)' },
      { name: 'fill-selection', ref: 'rose-1000', cssOnly: true, use: 'Text selection, at 35%' },
      { name: 'fill-overlay', ref: 'black', alpha: 0.6, use: 'Scrim behind a dialog or sheet' },
    ],
  },
  {
    id: 'stroke',
    title: 'Stroke',
    utilities: 'border-stroke-*, divide-stroke-*, ring-stroke-*, and fill-stroke-* / bg-stroke-* for a hairline drawn as a shape',
    note: 'Borders and hairlines. The four neutral steps are named by weight, not by state, because the same weight serves hover in one place and rest in another.',
    tokens: [
      { name: 'stroke-weak', ref: 'sand-120', use: 'Dividers, quiet edges. The default border colour' },
      { name: 'stroke-strong', ref: 'sand-240', use: 'Card edges, control boundaries, rulers' },
      { name: 'stroke-stronger', ref: 'sand-500', use: 'A boundary on hover' },
      { name: 'stroke-strongest', ref: 'sand-700', use: 'An outlined button on hover' },
      { name: 'stroke-selected', ref: 'sand-1000', use: 'The chosen tab, chip or step' },
      { name: 'stroke-focused', ref: 'sun-1000', use: 'Keyboard focus ring, the focused amount field' },
      { name: 'stroke-primary', ref: 'sand-1000', use: 'Edge of a primary fill' },
      { name: 'stroke-primary-hover', ref: 'sand-bright', use: 'Edge of a primary fill, hovered' },
      { name: 'stroke-accent', ref: 'sun-1000', use: 'Edge of an accent fill, the chosen reward option' },
      { name: 'stroke-accent-hover', ref: 'sun-bright', use: 'Edge of an accent fill, hovered' },
      { name: 'stroke-success', ref: 'green-1000', use: 'Success edge (use /40)' },
      { name: 'stroke-error', ref: 'red-1000', use: 'Error edge (use /40), invalid field' },
      { name: 'stroke-warning', ref: 'tan-1000', use: 'Warning edge (use /40)' },
    ],
  },
];

export const SEMANTIC_TOKENS: SemanticToken[] = SEMANTIC_GROUPS.flatMap((g) => g.tokens);

const BY_NAME = new Map(SEMANTIC_TOKENS.map((t) => [t.name, t]));

/** `#RRGGBB` for a primitive. */
export function primitiveHex(name: PrimitiveName): string {
  return `#${PRIMITIVES[name].rgb.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** `#RRGGBB` for a semantic token, for chart libraries that cannot read CSS variables. */
export function tokenHex(name: string): string {
  const t = BY_NAME.get(name);
  if (!t) throw new Error(`Unknown colour token: ${name}`);
  return primitiveHex(t.ref);
}

/** The CSS variables for both layers, as Tailwind's `addBase` takes them. */
export function cssVariables(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, p] of Object.entries(PRIMITIVES)) vars[`--color-${name}`] = p.rgb.join(' ');
  for (const t of SEMANTIC_TOKENS) vars[`--color-${t.name}`] = t.alpha === undefined ? `var(--color-${t.ref})` : `var(--color-${t.ref}) / ${t.alpha}`;
  return vars;
}

/** The Tailwind `colors` map: semantic names only. */
export function tailwindColors(): Record<string, string> {
  const colors: Record<string, string> = { transparent: 'transparent', current: 'currentColor' };
  for (const t of SEMANTIC_TOKENS) {
    if (t.cssOnly) continue;
    colors[t.name] = t.alpha === undefined ? `rgb(var(--color-${t.name}) / <alpha-value>)` : `rgb(var(--color-${t.name}))`;
  }
  return colors;
}
