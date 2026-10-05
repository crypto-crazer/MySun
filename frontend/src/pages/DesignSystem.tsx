import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { BRAND } from '@/lib/brand';
import { cx } from '@/lib/format';
import { ActionsContent } from './design-system/Actions';
import { DataDisplayContent } from './design-system/DataDisplay';
import { FeedbackOverlaysContent } from './design-system/FeedbackOverlays';
import { FoundationContent } from './design-system/Foundation';
import { InputsControlsContent } from './design-system/InputsControls';
import { DEFAULT_TAB, TABS, type TabConfig, type TabId } from './design-system/nav';

/**
 * /design-system — the gallery of tokens and base components. Every specimen is the component the
 * app renders, so the page cannot drift from the product. It is not linked from the header: reach it
 * by address. Rules and token tables in prose live in docs/design-system.md.
 */

const CONTENT: Record<TabId, () => JSX.Element> = {
  foundation: FoundationContent,
  actions: ActionsContent,
  'inputs-controls': InputsControlsContent,
  'data-display': DataDisplayContent,
  'feedback-overlays': FeedbackOverlaysContent,
};

/** A section counts as current once its title has passed this far below the top of the window. */
const SPY_OFFSET = 140;

export function DesignSystem() {
  const { tab } = useParams<{ tab?: string }>();
  const location = useLocation();
  const active = TABS.find((t) => t.id === tab) ?? TABS.find((t) => t.id === DEFAULT_TAB)!;
  const Content = CONTENT[active.id];
  const current = useCurrentSection(active);

  // Follow the address: to the named section, or to the top of a newly chosen category.
  useEffect(() => {
    const id = location.hash.slice(1);
    const el = id ? document.getElementById(id) : null;
    if (el) el.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [location.key, location.hash, active.id]);

  return (
    <div className="wrap pb-[120px] pt-[52px]">
      <header className="mb-12 grid gap-4">
        <h1 className="title font-thin text-[clamp(44px,5.4vw,74px)]">Design system</h1>
        <p className="max-w-[60ch] text-md text-weak">
          The tokens and base components {BRAND.name} is built from. Every specimen on this page is the component the app renders, not a drawing of it.
        </p>
      </header>
      <div className="grid items-start gap-x-14 gap-y-8 lg:grid-cols-[216px_minmax(0,1fr)]">
        <SideNav active={active} current={current} />
        <div className="grid min-w-0 gap-[88px]">
          <Content />
        </div>
      </div>
    </div>
  );
}

function useCurrentSection(tab: TabConfig) {
  const [current, setCurrent] = useState(tab.items[0].id);
  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      let found = tab.items[0].id;
      for (const item of tab.items) {
        const el = document.getElementById(item.id);
        if (el && el.getBoundingClientRect().top <= SPY_OFFSET) found = item.id;
      }
      setCurrent(found);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [tab]);
  return current;
}

// ── SideNav (local to this page) ──────────────────────────────────────

function SideNav({ active, current }: { active: TabConfig; current: string }) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const matches = useMemo(
    () =>
      query
        ? TABS.flatMap((t) => t.items.filter((i) => [i.label, ...(i.keywords ?? [])].some((s) => s.toLowerCase().includes(query))).map((i) => ({ tab: t, item: i })))
        : [],
    [query],
  );

  return (
    <nav aria-label="Design system" className="grid gap-5 lg:sticky lg:top-[84px] lg:-m-1 lg:max-h-[calc(100vh-108px)] lg:overflow-y-auto lg:p-1">
      <label className="flex h-10 items-center gap-2 rounded border border-stroke-strong px-3 text-weaker focus-within:border-stroke-strongest">
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          aria-label="Search tokens and components"
          className="min-w-0 flex-1 bg-transparent text-sm text-strong outline-none placeholder:text-weaker focus-visible:outline-none"
        />
      </label>

      {query ? (
        <ul className="grid gap-0.5">
          {matches.map(({ tab, item }) => (
            <li key={`${tab.id}/${item.id}`}>
              <Link to={`/design-system/${tab.id}#${item.id}`} onClick={() => setQ('')} className="flex items-baseline justify-between gap-3 py-1.5 text-sm text-weak hover:text-strong">
                {item.label}
                <span className="text-xs text-weaker">{tab.label}</span>
              </Link>
            </li>
          ))}
          {!matches.length && <li className="py-1.5 text-sm text-weaker">Nothing matches "{q.trim()}".</li>}
        </ul>
      ) : (
        <ul className="flex gap-x-5 overflow-x-auto lg:grid lg:gap-4 lg:overflow-visible">
          {TABS.map((t) => {
            const open = t.id === active.id;
            return (
              <li key={t.id} className="shrink-0">
                <Link
                  to={`/design-system/${t.id}`}
                  aria-current={open ? 'page' : undefined}
                  className={cx('eyebrow flex items-baseline justify-between gap-3 whitespace-nowrap py-1 transition-colors', open ? '!text-strong' : 'hover:!text-strong')}
                >
                  {t.label}
                  {!open && <span className="num hidden normal-case tracking-normal lg:inline">{t.items.length}</span>}
                </Link>
                {open && (
                  <ul className="mt-2 hidden border-l border-stroke-weak lg:grid">
                    {t.items.map((i) => (
                      <li key={i.id}>
                        <Link
                          to={`/design-system/${t.id}#${i.id}`}
                          className={cx(
                            '-ml-px block border-l py-[5px] pl-3.5 text-sm transition-colors',
                            // the section in view is marked the way the header marks the page: a line in the sun colour
                            i.id === current ? 'border-stroke-accent text-strong' : 'border-transparent text-weak hover:text-strong',
                          )}
                        >
                          {i.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
