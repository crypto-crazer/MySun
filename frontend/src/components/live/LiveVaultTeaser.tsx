/** Markets entry point for the selected vault on the target chain (and a count of the others). */
import { Link } from 'react-router-dom';
import { useWallet } from '@/wallet/context';
import { formatAmountSignificant, shortHex } from '@/chain/amounts';
import { useLiveVault, useUserBasket } from '@/chain/useVault';
import { chainLabel, isLocalChain, vaultsForChain } from '@/chain/chains';
import { LiveBadge } from '@/components/ui/DataBadge';

export function LiveVaultTeaser() {
  const { address } = useWallet();
  const vault = useLiveVault();
  const user = useUserBasket(address, vault);
  const unreachable = vault.hasDeployment && (Boolean(vault.error) || (!vault.isLoading && vault.tokens.length === 0));
  const chainName = chainLabel(vault.chainId);
  const vaultCount = vaultsForChain(vault.chainId).length;

  return (
    <section className="bg-background-elevated border border-stroke-weak rounded-lg p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 min-w-0">
          <h2 className="display text-sm font-semibold">{vault.entry?.label ?? vault.name ?? 'MySun vault'}</h2>
          <LiveBadge />
          <span className="text-2xs text-weaker num truncate">
            {chainName}
            {vault.hasDeployment && <> · {vault.receipt.symbol} · {shortHex(vault.address)}</>}
            {vaultCount > 1 && <> · {vaultCount} vaults on this network</>}
          </span>
        </div>
        <Link
          to="/live"
          className="shrink-0 inline-flex items-center justify-center h-9 px-3 rounded-md bg-fill-primary text-inverse-strong text-xs font-medium hover:bg-fill-primary-hover transition-colors"
        >
          {unreachable || !vault.hasDeployment ? 'Open live vault' : 'Deposit in kind'}
        </Link>
      </div>

      {!vault.hasDeployment ? (
        <p className="mt-3 text-xs text-warning">
          No MySun deployment on {chainName} yet — switch network in the header. The prototype below keeps working.
        </p>
      ) : unreachable ? (
        <p className="mt-3 text-xs text-warning">
          {isLocalChain(vault.chainId)
            ? 'Local chain not reachable — start Anvil with the demo stack to see live data.'
            : `${chainName} RPC not reachable right now.`}{' '}
          The prototype below keeps working.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3 num">
          <Field label="Basket">
            {vault.tokens.length > 0 ? vault.tokens.map((t) => t.symbol).join(' + ') : '—'}
          </Field>
          <Field label={`${vault.receipt.symbol} supply`}>{formatAmountSignificant(vault.totalSupply, vault.decimals)}</Field>
          <Field label="Performance fee">{(vault.performanceFeeBps / 100).toFixed(2)}%</Field>
          <Field label="Your position">
            {user.shares > 0n ? `${formatAmountSignificant(user.shares, vault.decimals)} ${vault.receipt.symbol}` : '—'}
          </Field>
        </div>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-2xs text-weaker">{label}</div>
      <div className="text-sm text-strong truncate">{children}</div>
    </div>
  );
}
