/**
 * The one page where every number is real: the selected MySun vault on the target chain, read
 * over RPC. The target chain is the wallet's chain when MySun is deployed there, else the chain
 * picked in the header (src/chain/targetChain.ts); the vault is the one picked in the vault picker
 * for that chain, else its first vault (src/chain/vaultSelection.ts).
 * Anything this page cannot get from the chain simply is not shown — there is no APR here, no USD
 * value, no rewards. Those live on the prototype pages and are tagged as demo data.
 */
import { Fragment } from 'react';
import { useWallet } from '@/wallet/context';
import { Link } from 'react-router-dom';
import { DEPLOYMENTS } from '@/config/generated';
import { chainFor, chainLabel, isLocalChain, resolveLocalRpcUrl } from '@/chain/chains';
import { describeSwitchError } from '@/chain/switchChain';
import { NetworkManual } from '@/components/live/NetworkManual';
import { useSwitchToChain, useTargetChain } from '@/chain/useTargetChain';
import { formatAmount, formatAmountSignificant, shortHex } from '@/chain/amounts';
import { useLiveVault, useUserBasket } from '@/chain/useVault';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Stat, StatRow } from '@/components/ui/Stat';
import { Spinner } from '@/components/ui/Spinner';
import { DataLegend, LiveBadge } from '@/components/ui/DataBadge';
import { AdapterList } from '@/components/live/AdapterList';
import { LiveDepositCard } from '@/components/live/LiveDepositCard';
import { LiveRedeemCard } from '@/components/live/LiveRedeemCard';
import { LocalDevPanel } from '@/components/live/LocalDevPanel';
import { Message } from '@/components/live/Message';
import { TokenAmountList } from '@/components/live/TokenAmount';
import { VaultPicker } from '@/components/live/VaultPicker';
import { cx } from '@/lib/format';

export function LiveVault() {
  const { address, chainId } = useWallet();
  const { isWrongChain: wrongChain } = useTargetChain();
  const { switchTo, switching, error: switchError } = useSwitchToChain();
  const vault = useLiveVault();
  const switchTarget = chainFor(vault.chainId);
  const user = useUserBasket(address, vault);

  const chainName = chainLabel(vault.chainId);
  const { receipt } = vault;
  const unreachable = Boolean(vault.error) || (!vault.isLoading && vault.tokens.length === 0);
  const switchButton = (id: number) => (
    <Button key={id} size="sm" variant="secondary" loading={switching} onClick={() => void switchTo(id).catch(() => {})}>
      Switch to {chainLabel(id)}
    </Button>
  );

  return (
    <div className="wrap py-6 space-y-6">
      <header className="flex flex-wrap items-center gap-3">
        <Link to="/" className="text-xs text-weaker hover:text-weak mr-1">← Earn</Link>
        <h1 className="display text-2xl font-semibold">{vault.entry?.label ?? vault.name ?? 'MySun vault'}</h1>
        <LiveBadge />
        {vault.hasDeployment && (
          <span
            className="inline-flex items-center h-7 px-2.5 rounded-full bg-fill-weak border border-stroke-strong text-xs font-medium text-strong num"
            title={`Receipt token: ${receipt.name} (${receipt.symbol})`}
          >
            {receipt.symbol}
          </span>
        )}
        <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-background-elevated border border-stroke-weak text-xs text-weak num">
          {chainName}
          {vault.hasDeployment && <> · {shortHex(vault.address)}</>}
        </span>
        {vault.isLoading && <Spinner className="h-4 w-4 text-weaker" />}
      </header>

      <p className="text-sm text-weak max-w-3xl leading-relaxed">
        An in-kind basket vault: you deposit the basket tokens themselves and receive{' '}
        <span className="num">{receipt.symbol}</span>
        {receipt.name !== receipt.symbol && <> ({receipt.name})</>}, a fungible pro-rata claim on the whole basket. There is no USD
        valuation, no NAV and no oracle anywhere in this contract — every figure below is a token amount read from the chain.
      </p>

      {vault.hasDeployment && <VaultPicker chainId={vault.chainId} selectedKey={vault.entry?.key} />}

      {vault.hasDeployment && wrongChain && (
        <Message tone="warn">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Your wallet is on {chainLabel(chainId)}. Reads below come from {chainName}; switch network to deposit or redeem.
            </span>
            {switchButton(vault.chainId)}
          </div>
        </Message>
      )}

      {vault.hasDeployment && wrongChain && switchError && switchTarget && (
        <Message tone="error">{describeSwitchError(switchError, switchTarget)}</Message>
      )}

      {vault.hasDeployment && wrongChain && <NetworkManual chainId={vault.chainId} />}

      {!vault.hasDeployment ? (
        <Message tone="warn">
          <p>No MySun deployment on {chainName} yet. Switch to a network where the vault is live:</p>
          <div className="mt-2 flex flex-wrap gap-2">{DEPLOYMENTS.map((d) => switchButton(d.chainId))}</div>
        </Message>
      ) : unreachable ? (
        <Message tone="error">
          Cannot reach the vault at {vault.address} on {chainName} (
          {vault.deployment ? resolveLocalRpcUrl(vault.deployment.rpcUrl, vault.deployment.local === true) : ''}).{' '}
          {isLocalChain(vault.chainId) ? 'Start the local chain and the demo stack, then reload.' : 'The RPC did not answer; try again shortly.'}{' '}
          Everything else in the app keeps working on demo data.
        </Message>
      ) : (
        // Keyed by vault: switching vaults remounts the cards, so no half-typed amount, step or
        // "deposited" banner from one vault can survive into another.
        <Fragment key={`${vault.chainId}:${vault.address}`}>
          {vault.paused && (
            <Message tone="warn">Vault is paused — deposits, redemptions and keeper operations are frozen until the owner unpauses.</Message>
          )}

          <StatRow cols={4}>
            <Stat
              label={`${receipt.symbol} supply`}
              value={formatAmountSignificant(vault.totalSupply, vault.decimals)}
              sub={`${vault.tokens.length} basket tokens`}
            />
            <Stat
              label="Your share"
              value={
                vault.totalSupply === 0n || user.shares === 0n
                  ? '0%'
                  : `${((Number(user.shares) / Number(vault.totalSupply)) * 100).toFixed(2)}%`
              }
              sub={`${formatAmountSignificant(user.shares, vault.decimals)} ${receipt.symbol}`}
            />
            <Stat
              label="Performance fee"
              value={`${(vault.performanceFeeBps / 100).toFixed(2)}%`}
              sub="on harvested fees only, in kind"
            />
            <Stat
              label="Deposits"
              value={vault.paused ? 'Paused' : 'Open'}
              tone={vault.paused ? 'warning' : 'success'}
              sub={`${vault.adapters.length} adapters registered`}
            />
          </StatRow>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
            <div className="lg:col-span-2 space-y-6 min-w-0">
              <BasketTable vault={vault} />
              <AdapterList adapters={vault.adapters} tokens={vault.tokens} />
            </div>

            <div className="space-y-6 min-w-0">
              <Card title="Your position" action={<LiveBadge label="Live" />}>
                {user.shares === 0n ? (
                  <p className="text-sm text-weaker">
                    {address ? `No ${receipt.symbol} yet. Deposit below to mint a claim on the basket.` : 'Connect a wallet to see your position.'}
                  </p>
                ) : (
                  <>
                    <div className="flex items-baseline justify-between gap-3 mb-2">
                      <span className="text-xs text-weaker">{receipt.symbol} balance</span>
                      <span className="display num text-xl font-semibold">{formatAmountSignificant(user.shares, vault.decimals)}</span>
                    </div>
                    <div className="text-xs text-weaker mb-1">Redeemable right now (previewRedeem)</div>
                    <TokenAmountList tokens={vault.tokens} amounts={user.owed} digits={6} />
                  </>
                )}
              </Card>

              <LiveDepositCard vault={vault} user={user} />
              <LiveRedeemCard vault={vault} user={user} />
              {/* Local-only: the target is the local stack and no wallet is on another network. */}
              {isLocalChain(vault.chainId) && !wrongChain && <LocalDevPanel vault={vault} user={user} />}
            </div>
          </div>
        </Fragment>
      )}

      <DataLegend />
    </div>
  );
}

/** Per token: idle in the vault vs working inside adapter positions. totals = idle + positions. */
function BasketTable({ vault }: { vault: ReturnType<typeof useLiveVault> }) {
  return (
    <Card
      title="Basket"
      action={<span className="text-2xs text-weaker">totalTokens() = idle + Σ adapter position()</span>}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm num min-w-[460px]">
          <thead>
            <tr className="text-xs text-weaker border-b border-stroke-weak">
              <th className="text-left font-medium pb-2">Token</th>
              <th className="text-right font-medium pb-2">Total</th>
              <th className="text-right font-medium pb-2">Idle</th>
              <th className="text-right font-medium pb-2">In position</th>
              <th className="w-28 pb-2" />
            </tr>
          </thead>
          <tbody>
            {vault.tokens.map((t, i) => {
              const total = vault.totals[i] ?? 0n;
              const idle = vault.idle[i] ?? 0n;
              const working = vault.inPosition[i] ?? 0n;
              const pct = total > 0n ? Number((working * 10_000n) / total) / 100 : 0;
              return (
                <tr key={t.address} className="border-b border-stroke-weak last:border-0">
                  <td className="py-2.5">
                    <div className="font-medium text-strong">{t.symbol}</div>
                    <div className="text-2xs text-weaker" title={t.address}>
                      {t.name} · {t.decimals} dp · {shortHex(t.address)}
                    </div>
                  </td>
                  <td className="py-2.5 text-right text-strong">{formatAmount(total, t.decimals, 4)}</td>
                  <td className="py-2.5 text-right text-weak">{formatAmount(idle, t.decimals, 4)}</td>
                  <td className="py-2.5 text-right text-weak">{formatAmount(working, t.decimals, 4)}</td>
                  <td className="py-2.5 pl-3">
                    <div className="h-1.5 w-full rounded-full bg-fill-track overflow-hidden" title={`${pct.toFixed(1)}% deployed`}>
                      <div className={cx('h-full rounded-full bg-fill-primary')} style={{ width: `${Math.min(100, pct)}%` }} />
                    </div>
                    <div className="text-2xs text-weaker mt-1 text-right">{pct.toFixed(1)}% deployed</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
