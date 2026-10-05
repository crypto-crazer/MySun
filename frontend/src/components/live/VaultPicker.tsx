/**
 * Which vault on the target chain the live page is about. Rendered from the REGISTRY (label, receipt
 * symbol, address), so it shows before — and without — a wallet or a reachable node; each card then
 * enriches itself with a small live basket hint (token count + symbols, receipt supply) read over RPC.
 *
 * One vault → a static strip (nothing to choose). Two or more → a radio group of cards; the choice is
 * remembered per chain (src/chain/vaultSelection.ts).
 */
import type { Address } from 'viem';
import { erc20Abi } from 'viem';
import { vaultAbi } from '@/config/generated';
import { chainShortLabel, vaultsForChain, type VaultEntry } from '@/chain/chains';
import { formatAmountSignificant, shortHex } from '@/chain/amounts';
import { pick, useReads } from '@/chain/useReads';
import { useSelectVault } from '@/chain/useTargetChain';
import { cx } from '@/lib/format';

/** How many basket symbols a card lists before "+N". */
const HINT_SYMBOLS = 3;

export function VaultPicker({ chainId, selectedKey }: { chainId: number; selectedKey: string | undefined }) {
  const vaults = vaultsForChain(chainId);
  const select = useSelectVault();
  if (vaults.length === 0) return null;

  if (vaults.length === 1) {
    const [only] = vaults;
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-stroke-weak bg-background-elevated px-4 py-2.5 text-xs">
        <span className="text-weaker">Vault</span>
        <span className="font-medium text-strong">{only.label}</span>
        <ReceiptChip symbol={only.receipt.symbol} />
        <span className="num text-weaker" title={only.vault}>{shortHex(only.vault)}</span>
      </div>
    );
  }

  return (
    <section aria-label="Vault picker" className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="display text-sm font-semibold">
          {vaults.length} vaults on {chainShortLabel(chainId)}
        </h2>
        <span className="text-2xs text-weaker">Each vault is its own basket with its own receipt token</span>
      </div>
      <div
        role="radiogroup"
        aria-label={`Vaults on ${chainShortLabel(chainId)}`}
        className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3"
      >
        {vaults.map((v) => (
          <VaultCard key={v.key} chainId={chainId} vault={v} selected={v.key === selectedKey} onSelect={() => select(v.key)} />
        ))}
      </div>
    </section>
  );
}

function ReceiptChip({ symbol }: { symbol: string }) {
  return (
    <span className="inline-flex items-center h-5 px-1.5 rounded border border-stroke-strong bg-fill-weak text-2xs font-medium num text-weak whitespace-nowrap">
      {symbol}
    </span>
  );
}

function VaultCard({
  chainId,
  vault,
  selected,
  onSelect,
}: {
  chainId: number;
  vault: VaultEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const hint = useBasketHint(chainId, vault.vault);
  // The registry's receipt symbol should be what `initialize` set; say so if the chain disagrees.
  const mismatch = hint.symbol !== undefined && hint.symbol !== vault.receipt.symbol;

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`${vault.label} (${vault.receipt.symbol})`}
      onClick={onSelect}
      className={cx(
        'group text-left rounded-lg border p-3.5 transition-colors min-w-0',
        selected ? 'border-stroke-selected/70 bg-fill-primary/5 ring-1 ring-stroke-selected/30' : 'border-stroke-weak bg-background-elevated hover:border-stroke-strong',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className={cx('text-sm font-medium leading-snug', selected ? 'text-strong' : 'text-weak group-hover:text-strong')}>
          {vault.label}
        </span>
        <span
          aria-hidden
          className={cx(
            'mt-0.5 h-4 w-4 shrink-0 rounded-full border inline-flex items-center justify-center',
            selected ? 'border-stroke-primary bg-fill-primary' : 'border-stroke-strong',
          )}
        >
          {selected && <span className="h-1.5 w-1.5 rounded-full bg-inverse-strong" />}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-2xs">
        <ReceiptChip symbol={vault.receipt.symbol} />
        <span className="num text-weaker" title={vault.vault}>{shortHex(vault.vault)}</span>
        <span className="text-weaker">· {vault.key}</span>
      </div>

      <div className="mt-2 text-2xs text-weaker num truncate" title={hint.symbols.join(' · ')}>
        {hint.symbols.length > 0 ? (
          <>
            {hint.symbols.length} tokens · {hint.symbols.slice(0, HINT_SYMBOLS).join(' · ')}
            {hint.symbols.length > HINT_SYMBOLS && ` +${hint.symbols.length - HINT_SYMBOLS}`}
            {hint.supply !== undefined && <> · supply {formatAmountSignificant(hint.supply, hint.decimals)}</>}
          </>
        ) : hint.failed ? (
          'basket not reachable'
        ) : (
          'reading basket…'
        )}
      </div>
      {mismatch && <div className="mt-1.5 text-2xs text-warning">On-chain symbol is {hint.symbol} — registry entry is stale</div>}
    </button>
  );
}

/** A card's live extras: basket symbols, receipt supply and on-chain symbol — scoped to that vault. */
function useBasketHint(chainId: number, vault: Address) {
  const target = { address: vault, abi: vaultAbi } as const;
  const basics = useReads(
    [
      { ...target, functionName: 'tokens' },
      { ...target, functionName: 'totalSupply' },
      { ...target, functionName: 'decimals' },
      { ...target, functionName: 'symbol' },
    ],
    { chainId, scope: vault },
  );
  const tokens = pick<readonly Address[]>(basics.data, 0) ?? [];
  const symbolReads = useReads(
    tokens.map((t) => ({ address: t, abi: erc20Abi, functionName: 'symbol' }) as const),
    { chainId, scope: vault, enabled: tokens.length > 0 },
  );
  return {
    symbols: tokens.map((t, i) => pick<string>(symbolReads.data, i) ?? shortHex(t)),
    supply: pick<bigint>(basics.data, 1),
    decimals: Number(pick<number>(basics.data, 2) ?? 18),
    symbol: pick<string>(basics.data, 3),
    failed: Boolean(basics.error),
  };
}
