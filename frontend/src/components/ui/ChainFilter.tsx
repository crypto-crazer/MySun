import { CHAINS, type ChainId } from '@/demo/data/chains';
import { cx } from '@/lib/format';

// First phase: Robinhood Chain only. Add a second chain here and the filter shows itself again.
const ORDER: ChainId[] = ['robinhood'];

/** Network filter as a row of text tabs; the chosen one is underlined. With one chain there is nothing to choose, so it draws nothing. */
export function ChainFilter({ value, onChange }: { value: ChainId | 'all'; onChange: (v: ChainId | 'all') => void }) {
  if (ORDER.length < 2) return null;
  const options: Array<{ id: ChainId | 'all'; label: string; isNew?: boolean }> = [
    { id: 'all', label: 'All networks' },
    ...ORDER.map((id) => ({ id, label: CHAINS[id].name, isNew: CHAINS[id].isNew })),
  ];
  return (
    <div className="flex flex-wrap gap-0.5 text-sm" role="group" aria-label="Network">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={cx(
            'relative inline-flex items-baseline gap-1.5 px-2.5 py-2 transition-colors',
            value === o.id ? 'text-strong after:absolute after:inset-x-2.5 after:bottom-0 after:h-px after:bg-strong' : 'text-weaker hover:text-strong',
          )}
        >
          {o.label}
          {o.isNew && <span className="text-[9.5px] uppercase tracking-[0.1em] text-accent">New</span>}
        </button>
      ))}
    </div>
  );
}
