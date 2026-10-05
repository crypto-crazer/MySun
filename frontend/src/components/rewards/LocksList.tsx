import { useState } from 'react';
import * as m from '@/demo/math';
import { fmtDate, fmtToken } from '@/lib/format';
import type { Lock } from '@/lib/types';
import { useStore } from '@/store/useStore';
import { Button } from '@/components/ui/Button';

const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Every lock: all of them on one date scale with today marked, then each as its own row. Lives inside the claim sheet. */
export function LocksList() {
  const locks = useStore((s) => s.user.locks);
  const unlock = useStore((s) => s.unlock);
  const pushToast = useStore((s) => s.pushToast);
  const [busy, setBusy] = useState<string | null>(null);
  const now = Date.now();
  if (locks.length === 0) return null;
  const total = m.lockedTide(locks);
  const sorted = [...locks].sort((a, b) => a.unlockAt - b.unlockAt);

  const doUnlock = async (id: string, amount: number) => {
    setBusy(id);
    await new Promise((r) => setTimeout(r, 1500));
    unlock(id);
    setBusy(null);
    pushToast({ title: 'Unlock confirmed', detail: `${fmtToken(amount, 1)} PMG returned to your wallet`, tone: 'success' });
  };

  return (
    <section>
      <h3 className="eyebrow mb-3 flex justify-between gap-2.5">
        Locked PMG
        <span className="num text-sm normal-case tracking-normal text-accent">{fmtToken(total, 0)} PMG</span>
      </h3>
      <Timeline locks={sorted} now={now} />
      <ul className="mt-2">
        {sorted.map((l) => {
          const ready = m.isUnlockable(l, now);
          return (
            <li key={l.id} className="flex items-center justify-between gap-3 border-t border-stroke-weak py-3 num">
              <div className="min-w-0">
                <span className="font-medium text-strong">{fmtToken(l.amount, 1)} PMG</span>
                {l.redistributionEarned > 0 && <span className="ml-1.5 text-xs text-success">+{fmtToken(l.redistributionEarned, 1)} earned</span>}
                <small className="mt-0.5 block text-xs text-weaker">
                  Locked {fmtDate(l.lockedAt)} · {ready ? <span className="text-success">ready to unlock</span> : <>unlocks {fmtDate(l.unlockAt)} · {m.lockDaysLeft(l, now)}d left</>}
                </small>
              </div>
              {ready && <Button size="sm" onClick={() => doUnlock(l.id, l.amount)} loading={busy === l.id}>Unlock</Button>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Locks as bars on a month scale: the part already served is solid, the rest is faint, today is the sun-coloured line. */
function Timeline({ locks, now }: { locks: Lock[]; now: number }) {
  const W = 448, ROW = 22, TOP = 26;
  const H = TOP + locks.length * ROW + 30;
  const first = new Date(Math.min(now, ...locks.map((l) => l.lockedAt)));
  const last = new Date(Math.max(now, ...locks.map((l) => l.unlockAt)));
  const d0 = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1);
  const d1 = Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1);
  const X = (t: number) => 4 + ((t - d0) / (d1 - d0)) * (W - 8);
  const months: number[] = [];
  for (let t = d0; t <= d1; ) {
    months.push(t);
    const d = new Date(t);
    t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  const every = Math.ceil((months.length - 1) / 7); // label at most seven months
  const xNow = X(now);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`Locked rewards on a timeline from ${fmtDate(d0)} to ${fmtDate(d1 - DAY)}`}>
      {months.map((t, i) => (
        <g key={t}>
          <rect x={X(t)} y={TOP - 6} width="1" height={H - TOP - 18} className="fill-stroke-weak" />
          {i < months.length - 1 && i % every === 0 && <text x={X(t) + 4} y={H - 6} fontSize="10.5" className="fill-weaker">{MONTHS[new Date(t).getUTCMonth()]}</text>}
        </g>
      ))}
      {locks.map((l, i) => {
        const y = TOP + i * ROW, x0 = X(l.lockedAt), x1 = X(l.unlockAt), served = Math.min(xNow, x1);
        return (
          <g key={l.id}>
            <rect x={x0} y={y} width={x1 - x0} height="8" className="fill-strong" opacity=".22" />
            <rect x={x0} y={y} width={Math.max(0, served - x0)} height="8" className={m.isUnlockable(l, now) ? 'fill-success' : 'fill-strong'} />
          </g>
        );
      })}
      <rect x={xNow} y="4" width="1" height={H - 22} className="fill-accent" />
      <text x={xNow + 5 > W - 40 ? xNow - 5 : xNow + 5} y="13" textAnchor={xNow + 5 > W - 40 ? 'end' : 'start'} fontSize="10.5" className="fill-accent">Today</text>
    </svg>
  );
}
