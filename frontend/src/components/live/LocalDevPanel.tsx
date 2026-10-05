/**
 * Local-chain conveniences. Rendered ONLY when the target chain is the local Anvil stack
 * (`isLocalChain`) and no wallet is on another network. The mint rows need the public
 * `MockToken.mint`, so they are shown only when the stack is mintable (`canMintMocks`): on the RHC
 * fork (`mintable: false`) the mint rows are gone and the fund path (src/chain/faucet.ts) sends
 * the basket instead — every token by an impersonated call from the pool: a `transfer` for a real
 * token, the public `mint` for a mock. No wallet prompt either way; the wallet only names the
 * destination. It FIRST tops the wallet up to 1 ETH for gas (`fundEth`) so the approve and deposit
 * that follow can be signed.
 * With no wallet connected the fork CTA is an enabled "Connect wallet" that opens the picker (the
 * deposit card's connect-first pattern), never a dead disabled button.
 */
import { useState } from 'react';
import { mockTokenAbi } from '@/config/generated';
import { useWallet } from '@/wallet/context';
import { waitForReceipt } from '@/chain/client';
import { canMintMocks, chainLabel, isForkDeployment, resolveLocalRpcUrl } from '@/chain/chains';
import { formatAmount, parseAmount, shortHex } from '@/chain/amounts';
import { faucetAmount, faucetKind, fundEth, impersonatedFund } from '@/chain/faucet';
import { describeChainError } from '@/chain/errors';
import { useConnectWallet } from '@/chain/useConnectWallet';
import type { LiveVault, UserBasket } from '@/chain/useVault';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useStore } from '@/store/useStore';
import { Message } from './Message';

const DEFAULT_MINT = '1000';

export function LocalDevPanel({ vault, user }: { vault: LiveVault; user: UserBasket }) {
  const { address, write } = useWallet();
  const { connectWallet, isPending: connecting } = useConnectWallet();
  const demoWallet = useStore((s) => s.demoWallet);
  const pushToast = useStore((s) => s.pushToast);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mint = async (token: `0x${string}`, decimals: number, symbol: string) => {
    if (!address) return;
    const parsed = parseAmount(amounts[token] ?? DEFAULT_MINT, decimals);
    if (!parsed.ok) {
      setError(`${symbol}: ${parsed.error}`);
      return;
    }
    setError(null);
    setPending(token);
    try {
      // Gas first: a wallet with no ETH cannot sign the mint below (local node only).
      await fundEth(vault.chainId, address);
      const hash = await write({
        chainId: vault.chainId,
        address: token,
        abi: mockTokenAbi,
        functionName: 'mint',
        args: [address, parsed.value],
      });
      await waitForReceipt(vault.chainId, hash);
      user.refetch();
      pushToast({
        title: `Minted ${symbol}`,
        detail: `Test tokens for ${vault.entry?.label ?? 'the vault'} sent to your wallet (local chain only).`,
        tone: 'success',
      });
    } catch (err) {
      setError(describeChainError(err));
    } finally {
      setPending(null);
    }
  };

  /** One amount summary for the faucet: `10,000 USDG + 10 WETH`. */
  const faucetDetail = vault.tokens
    .map((t) => `${formatAmount(faucetAmount(t.decimals), t.decimals)} ${t.symbol}`)
    .join(' + ');

  /** Fork stack: the basket tokens are real, so send them to the connected wallet instead. */
  const fund = async () => {
    if (!address) return;
    setError(null);
    setPending('faucet');
    try {
      // Gas first: the funding itself is RPC-only, but the approve + deposit that follow are
      // signed by the wallet, so it must hold ETH already (local node only).
      await fundEth(vault.chainId, address);
      for (const t of vault.tokens) {
        const amount = faucetAmount(t.decimals);
        // The wallet is only the destination: the pool sends every token, mocks included — a mock
        // mints, a real token transfers, and neither needs a signature.
        const kind = await faucetKind(vault.chainId, t.address, address, amount);
        await impersonatedFund(vault.chainId, kind, t.address, address, amount);
      }
      user.refetch();
      pushToast({
        title: 'Wallet funded',
        detail: `${faucetDetail} sent to your wallet, gas topped up to 1 ETH (local fork only).`,
        tone: 'success',
      });
    } catch (err) {
      setError(describeChainError(err));
    } finally {
      setPending(null);
    }
  };

  const { deployment, entry } = vault;
  if (!deployment || !entry) return null;
  const mintable = canMintMocks(deployment);
  const fork = isForkDeployment(deployment);

  return (
    <Card
      title="Local dev tools"
      action={
        <span className="text-2xs text-warning">
          {mintable ? 'Local chain only · MockToken.mint is public here' : 'Local fork · real tokens, no minting'}
        </span>
      }
    >
      <dl className="text-2xs num grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 mb-3">
        <dt className="text-weaker">Network</dt>
        <dd className="text-weak">
          {chainLabel(deployment.chainId)} · chain id {deployment.chainId}
        </dd>
        {fork && (
          <>
            <dt className="text-weaker">Stack</dt>
            <dd className="text-weak">Anvil fork of Robinhood Chain · real Uniswap pools</dd>
          </>
        )}
        <dt className="text-weaker">RPC</dt>
        <dd className="text-weak break-all">{resolveLocalRpcUrl(deployment.rpcUrl, deployment.local === true)}</dd>
        <dt className="text-weaker">Vault</dt>
        <dd className="text-weak" title={entry.vault}>
          {entry.key} · {shortHex(entry.vault)} · {vault.receipt.symbol}
        </dd>
        <dt className="text-weaker">Keeper</dt>
        <dd className="text-weak" title={entry.keeper}>{shortHex(entry.keeper)}</dd>
      </dl>

      {mintable ? (
        <>
          <div className="space-y-2">
            {vault.tokens.map((t) => (
              <div key={t.address} className="flex items-center gap-2">
                <span className="text-xs text-weak w-20 shrink-0">{t.symbol}</span>
                <input
                  inputMode="decimal"
                  value={amounts[t.address] ?? DEFAULT_MINT}
                  onChange={(e) => setAmounts((s) => ({ ...s, [t.address]: e.target.value }))}
                  aria-label={`Amount of ${t.symbol} to mint`}
                  className="h-9 flex-1 min-w-0 rounded-md bg-fill-recessed border border-stroke-weak px-2.5 text-sm num text-strong outline-none focus:border-stroke-strong"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!address || pending !== null}
                  loading={pending === t.address}
                  onClick={() => void mint(t.address, t.decimals, t.symbol)}
                >
                  Mint
                </Button>
              </div>
            ))}
          </div>
          {!address && <p className="mt-2 text-2xs text-weaker">Connect a wallet on the local chain to mint.</p>}
          {error && <div className="mt-2"><Message tone="error">{error}</Message></div>}
        </>
      ) : (
        <>
          <Button
            size="sm"
            variant="secondary"
            disabled={address ? pending !== null : false}
            loading={address ? pending === 'faucet' : connecting}
            onClick={() => (address ? void fund() : connectWallet())}
          >
            {address ? 'Fund my wallet' : 'Connect wallet'}
          </Button>
          <p className="mt-2 text-2xs text-weaker">
            No minting on this stack: it is an Anvil fork and the basket comes straight from the pool. The
            button tops your wallet up to 1 ETH for gas and sends {faucetDetail} — every token by an
            anvil-impersonated call from the pool (transfer for a real token, mint for a mock), local node
            only, no wallet prompts.
          </p>
          {!address && demoWallet && (
            <p className="mt-2 text-2xs text-weaker">
              The demo wallet is read-only: it cannot fund or sign. Connect a browser wallet to fund it.
            </p>
          )}
          {error && <div className="mt-2"><Message tone="error">{error}</Message></div>}
        </>
      )}
    </Card>
  );
}
