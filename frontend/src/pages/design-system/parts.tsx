import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '@/lib/format';

/** One entry of the gallery: a title on a rule, the file it documents, and its specimens. */
export function Section({ id, title, source, lede, status, children }: { id: string; title: string; source?: string; lede?: ReactNode; /** e.g. "Not used in the app yet" */ status?: string; children: ReactNode }) {
  return (
    <section id={id} className="grid scroll-mt-28 gap-8">
      <header className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-stroke-strong pb-3">
          <h2 className="title text-[28px]">{title}</h2>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {status && <span className="text-2xs uppercase tracking-[0.1em] text-warning">{status}</span>}
            {source && <code className="font-mono text-xs text-weaker">{source}</code>}
          </div>
        </div>
        {lede && <p className="max-w-[64ch] text-md text-weak">{lede}</p>}
      </header>
      {children}
    </section>
  );
}

export function SubSection({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-3.5">
      <div className="grid gap-1.5">
        <h3 className="eyebrow !text-weak">{title}</h3>
        {note && <p className="max-w-[64ch] text-sm text-weaker">{note}</p>}
      </div>
      {children}
    </div>
  );
}

/** A frame around the real component, with the code that produced it underneath. */
const ALIGN = { center: 'items-center', start: 'items-start', end: 'items-end', baseline: 'items-baseline' };

export function Specimen({ children, code, surface = 'base', align = 'center', className }: { children: ReactNode; code?: string; surface?: 'base' | 'elevated'; align?: keyof typeof ALIGN; className?: string }) {
  return (
    <figure className="min-w-0 overflow-hidden rounded-lg border border-stroke-weak">
      <div className={cx('flex flex-wrap gap-x-6 gap-y-4 p-5 sm:p-6', ALIGN[align], surface === 'elevated' && 'bg-background-elevated', className)}>{children}</div>
      {code && <figcaption className="overflow-x-auto whitespace-nowrap border-t border-stroke-weak px-4 py-2.5 font-mono text-xs text-weaker">{code}</figcaption>}
    </figure>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[0.92em] text-strong">{children}</code>;
}

export interface PropRow {
  name: string;
  type: string;
  def?: string;
  note: ReactNode;
}

/** Props as rows on hairlines: name, type, default, what it does. */
export function PropsTable({ rows }: { rows: PropRow[] }) {
  return (
    <dl className="divide-y divide-stroke-weak border-y border-stroke-weak text-sm">
      {rows.map((r) => (
        <div key={r.name} className="grid gap-x-6 gap-y-1 py-2.5 sm:grid-cols-[150px_minmax(0,1fr)] lg:grid-cols-[150px_minmax(0,1.1fr)_minmax(0,1.4fr)]">
          <dt className="font-mono text-xs leading-[18px] text-strong">{r.name}</dt>
          <dd className="font-mono text-xs leading-[18px] text-weak [overflow-wrap:anywhere]">
            {r.type}
            {r.def && <span className="text-weaker"> = {r.def}</span>}
          </dd>
          <dd className="text-weak sm:col-start-2 lg:col-start-3">{r.note}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Rules as rows: what to write, and what it replaces. */
export function Rule({ title, children, yes, no }: { title: string; children: ReactNode; yes?: string[]; no?: string[] }) {
  return (
    <div className="grid gap-x-8 gap-y-2.5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="grid content-start gap-1">
        <h4 className="display text-base text-strong">{title}</h4>
        <p className="max-w-[52ch] text-sm text-weak">{children}</p>
      </div>
      <div className="grid content-start gap-1.5 font-mono text-xs">
        {yes?.map((c) => (
          <div key={c} className="flex gap-2.5"><span className="w-10 shrink-0 text-success">Use</span><span className="text-strong [overflow-wrap:anywhere]">{c}</span></div>
        ))}
        {no?.map((c) => (
          <div key={c} className="flex gap-2.5"><span className="w-10 shrink-0 text-error">Not</span><span className="text-weaker line-through decoration-stroke-stronger [overflow-wrap:anywhere]">{c}</span></div>
        ))}
      </div>
    </div>
  );
}

/**
 * Reads computed style off the specimen itself, so the gallery prints what the browser applies
 * rather than a number typed in beside it.
 */
export function useComputed<T extends Element>(props: string[]): [React.RefObject<T>, string[]] {
  const ref = useRef<T>(null);
  const [values, setValues] = useState<string[]>([]);
  const key = props.join(',');
  useLayoutEffect(() => {
    if (!ref.current) return;
    const cs = getComputedStyle(ref.current);
    setValues(key.split(',').map((p) => cs.getPropertyValue(p)));
  }, [key]);
  return [ref, values];
}

/** `12.5px` → `12.5`, for printing sizes without the unit repeated. */
export const px = (v: string | undefined) => (v ? String(Math.round(parseFloat(v) * 100) / 100) : '');
