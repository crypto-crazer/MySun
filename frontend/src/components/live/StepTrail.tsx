import { cx } from '@/lib/format';

export type StepState = 'todo' | 'active' | 'done';

/** Approve → deposit → done, rendered as a hairline trail. No animation beyond the active dot. */
export function StepTrail({ steps }: { steps: Array<{ label: string; state: StepState }> }) {
  return (
    <ol className="flex items-center gap-2 text-2xs">
      {steps.map((s, i) => (
        <li key={s.label} className="flex items-center gap-2">
          <span
            className={cx(
              'inline-flex items-center gap-1.5',
              s.state === 'done' ? 'text-success' : s.state === 'active' ? 'text-strong' : 'text-weaker',
            )}
          >
            <span
              className={cx(
                'h-4 w-4 rounded-full border inline-flex items-center justify-center leading-none',
                s.state === 'done' ? 'border-stroke-success bg-fill-success/15' : s.state === 'active' ? 'border-stroke-selected' : 'border-stroke-strong',
              )}
            >
              {s.state === 'done' ? '✓' : i + 1}
            </span>
            {s.label}
          </span>
          {i < steps.length - 1 && <span className="h-px w-4 bg-stroke-strong" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}
