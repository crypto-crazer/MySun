import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Vault } from '@/lib/types';
import { DepositCard } from './DepositCard';

/** The deposit card as an overlay, opened from a vault row. */
export function DepositModal({ vault, onClose }: { vault: Vault | null; onClose: () => void }) {
  useEffect(() => {
    if (!vault) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [vault, onClose]);
  if (!vault) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[72px] overflow-y-auto" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-fill-overlay backdrop-blur-[4px]" onClick={onClose} />
      <div className="relative w-full max-w-[440px] animate-fade-in">
        <button onClick={onClose} className="absolute -top-8 right-0 text-xs text-weak hover:text-strong" aria-label="Close">Close ✕</button>
        <div className="shadow-pop">
          <DepositCard key={vault.id} vault={vault} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
