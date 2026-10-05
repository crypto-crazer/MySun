import { useStore } from '@/store/useStore';
import { useUserDerived } from '@/store/selectors';
import * as m from '@/demo/math';
import { fmtToken } from '@/lib/format';
import { Mark } from '@/components/brand/Mark';

/** One useful line about the user's own position, shown once connected. */
export function Sidekick({ onClaim }: { onClaim: () => void }) {
  const d = useUserDerived();
  const locks = useStore((s) => s.user.locks);
  const now = Date.now();
  const ready = locks.filter((l) => m.isUnlockable(l, now)).reduce((a, l) => a + l.amount + l.redistributionEarned, 0);
  const link = 'text-accent underline underline-offset-[3px] hover:text-accent-bright';
  let line: React.ReactNode;
  if (ready > 0) line = <>You have <b className="font-medium text-strong">{fmtToken(ready, 0)} PMG</b> ready to unlock. <button onClick={onClaim} className={link}>View</button></>;
  else if (d.pendingTide >= 1) line = <><b className="font-medium text-strong">{fmtToken(d.pendingTide, 0)} PMG</b> is waiting for you. <button onClick={onClaim} className={link}>Claim or lock it</button></>;
  else if (d.hasPositions) line = <>Your vaults are rebalancing and compounding on their own. Nothing to do.</>;
  else line = <>Pick a vault below to start. Deposit one asset and the vault does the rest.</>;
  return (
    <p className="inline-flex items-center gap-2.5 rounded border border-stroke-strong bg-background-base/55 py-[7px] pl-2 pr-3 text-sm text-weak">
      <Mark size={20} className="text-strong" />
      <span>{line}</span>
    </p>
  );
}
