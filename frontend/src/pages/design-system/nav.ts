export type TabId = 'foundation' | 'actions' | 'inputs-controls' | 'data-display' | 'feedback-overlays';

export interface NavItem {
  id: string;
  label: string;
  /** Search-only aliases (never rendered), matched against the query together with the label. */
  keywords?: string[];
}

export interface TabConfig {
  id: TabId;
  label: string;
  items: NavItem[];
}

// Within a category, items are ordered by relatedness, not alphabetically: same-family entries stay
// adjacent (Stat next to Stat row, Badges next to Data badges) with the generic entry before its
// specialisations. Insert a new item next to its family, not at the end.
export const TABS: TabConfig[] = [
  {
    id: 'foundation',
    label: 'Foundation',
    items: [
      { id: 'typography', label: 'Typography', keywords: ['font', 'type scale', 'zodiak', 'geist', 'switzer', 'figures', 'weight'] },
      { id: 'base-colors', label: 'Base colors', keywords: ['primitive', 'palette', 'ramp', 'plum', 'sand', 'sun'] },
      { id: 'semantic-colors', label: 'Semantic colors', keywords: ['token', 'text', 'fill', 'stroke', 'background', 'border'] },
      { id: 'surfaces', label: 'Surfaces & depth', keywords: ['elevation', 'shadow', 'layer'] },
      { id: 'shape', label: 'Shape', keywords: ['radius', 'rounded', 'corner', 'circle'] },
      { id: 'spacing', label: 'Spacing & layout', keywords: ['gutter', 'container', 'wrap', 'breakpoint', 'grid'] },
      { id: 'motion', label: 'Motion', keywords: ['animation', 'easing', 'duration', 'transition'] },
      { id: 'marks', label: 'Marks & textures', keywords: ['logo', 'ruler', 'hatch', 'wordmark'] },
      { id: 'layering', label: 'Layering', keywords: ['z-index', 'stack'] },
      { id: 'focus', label: 'Focus', keywords: ['keyboard', 'outline', 'accessibility'] },
    ],
  },
  {
    id: 'actions',
    label: 'Actions',
    items: [{ id: 'button', label: 'Button', keywords: ['cta', 'primary', 'accent', 'ghost', 'danger', 'loading'] }],
  },
  {
    id: 'inputs-controls',
    label: 'Inputs & controls',
    items: [
      { id: 'amount-input', label: 'Amount input', keywords: ['field', 'number', 'max', 'balance', 'error'] },
      { id: 'toggle', label: 'Toggle', keywords: ['switch'] },
      { id: 'segmented', label: 'Segmented', keywords: ['tabs', 'segmented control'] },
      { id: 'underline-tabs', label: 'Underline tabs', keywords: ['tabs'] },
      { id: 'chain-filter', label: 'Chain filter', keywords: ['network'] },
      { id: 'native-controls', label: 'Slider & checkbox', keywords: ['range', 'native'] },
    ],
  },
  {
    id: 'data-display',
    label: 'Data display',
    items: [
      { id: 'card', label: 'Card', keywords: ['panel', 'container'] },
      { id: 'stat', label: 'Stat', keywords: ['metric', 'kpi', 'reading'] },
      { id: 'stat-row', label: 'Stat row', keywords: ['ruler', 'readings'] },
      { id: 'key-value', label: 'Key value', keywords: ['kv', 'list', 'definition', 'row'] },
      { id: 'badges', label: 'Badges', keywords: ['tier', 'range status', 'pill', 'tag', 'chip'] },
      { id: 'data-badges', label: 'Data badges', keywords: ['demo', 'live', 'provenance', 'legend'] },
      { id: 'token-icon', label: 'Token icon', keywords: ['asset', 'coin', 'pair'] },
      { id: 'chain-logo', label: 'Chain logo', keywords: ['network'] },
      { id: 'boosted-apr', label: 'Boosted APR', keywords: ['reward', 'spark'] },
      { id: 'collapsible', label: 'Collapsible', keywords: ['accordion', 'disclosure', 'expand'] },
    ],
  },
  {
    id: 'feedback-overlays',
    label: 'Feedback & overlays',
    items: [
      { id: 'tooltip', label: 'Tooltip', keywords: ['hint', 'info dot', 'help'] },
      { id: 'toast', label: 'Toast', keywords: ['snackbar', 'notification'] },
      { id: 'spinner', label: 'Spinner', keywords: ['loading', 'loader', 'busy'] },
      { id: 'modal', label: 'Modal', keywords: ['dialog', 'popup', 'overlay'] },
    ],
  },
];

export const DEFAULT_TAB: TabId = 'foundation';
