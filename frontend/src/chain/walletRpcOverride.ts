/**
 * Wallet-facing RPC override for the local demo chain.
 *
 * The demo stack's RPC is reached over plain http on the LAN, and the major wallets refuse
 * dapp chain-adds whose `rpcUrls` are not https (MetaMask: "Expected … valid string HTTPS url
 * 'rpcUrls'"; OKX: https required). A quick HTTPS tunnel to the same anvil satisfies them, but
 * its URL rotates on every run — so it is NOT hard-coded: the tunnel script writes
 * `wallet-rpc.json` into the served `public/` dir, the app fetches it once, and every
 * wallet-facing value (add-chain params, manual-entry hint) uses the https URL while the app's
 * own reads keep the hostname-derived http RPC.
 */
export interface WalletRpcOverride {
  chainId: number;
  rpcUrl: string;
}

let current: WalletRpcOverride | null = null;
let loading: Promise<void> | null = null;

/** Set (or clear, with `null`) the override. The loader below and tests use this. */
export function setWalletRpcOverride(o: WalletRpcOverride | null): void {
  current = o;
}

/**
 * Fetch `/wallet-rpc.json` once per page load. Absent file, bad shape or any fetch failure simply
 * leaves the override unset — the hostname-derived RPC stays in charge. Never rejects, so callers
 * can `await` it unconditionally.
 */
export function ensureWalletRpcOverride(): Promise<void> {
  loading ??= (async () => {
    try {
      const res = await fetch('/wallet-rpc.json', { cache: 'no-store' });
      if (!res.ok) return;
      const j: unknown = await res.json();
      const o = j as Partial<WalletRpcOverride> | null;
      if (o && typeof o.chainId === 'number' && typeof o.rpcUrl === 'string' && /^https:\/\//i.test(o.rpcUrl)) {
        setWalletRpcOverride({ chainId: o.chainId, rpcUrl: o.rpcUrl });
      }
    } catch {
      /* no override — hostname-derived RPC stays in charge */
    }
  })();
  return loading;
}

/** The https wallet RPC when the tunnel override covers `chainId`, else null. */
export function walletRpcFor(chainId: number): string | null {
  return current && current.chainId === chainId ? current.rpcUrl : null;
}
