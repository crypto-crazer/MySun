/**
 * The manual half of "switch network": the exact EIP-3085 fields a wallet needs, one expand away.
 *
 * `wallet_addEthereumChain` is best-effort — wallets can refuse plain-http LAN RPCs, not implement
 * the method over WalletConnect (the request then never resolves), or already store this network
 * pointing at an address that has since changed (an add never overwrites an existing entry). The
 * app cannot fix any of that from here, so the visitor always gets the parameters — and the one
 * hint that actually bites on the demo stack: the RPC follows the machine serving the page.
 */
import { chainFor } from '@/chain/chains';
import { manualNetworkParams } from '@/chain/switchChain';

export function NetworkManual({ chainId }: { chainId: number }) {
  const chain = chainFor(chainId);
  if (!chain) return null;
  const params = manualNetworkParams(chain);
  const rows: [string, string][] = [
    ['Network name', params.chainName],
    ['RPC URL', params.rpcUrl],
    ['Chain ID', String(params.chainId)],
    ['Currency symbol', params.currencySymbol],
  ];
  return (
    <details className="text-2xs text-weaker">
      <summary className="cursor-pointer select-none hover:text-weak">Trouble switching? Add the network by hand</summary>
      <dl className="mt-1.5 space-y-0.5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline gap-2">
            <dt className="w-28 shrink-0">{label}</dt>
            <dd className="num text-weak break-all">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-1.5 leading-snug">
        Already added this network to your wallet? Update its RPC URL to the one above — the demo stack's LAN address
        changes with the network.
      </p>
    </details>
  );
}
