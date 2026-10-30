/**
 * Move a connected wallet to a chain: `wallet_switchEthereumChain`, and when the wallet does not
 * know the chain (always the case for the local Anvil node), `wallet_addEthereumChain` with
 * parameters built from the registry, then switch again. A chain the wallet ALREADY knows gets the
 * same add again, best-effort: a wallet that added the network for this site can refresh its entry
 * (MetaMask prompts), which is how a stale local-stack RPC — the LAN address moves — gets fixed.
 *
 * Wallet-facing RPC URLs are the chain's own `rpcUrls` — for the local stack the hostname-derived
 * (or same-origin `/rpc`) one the app reads through. MetaMask/OKX refuse dapp chain-adds whose
 * `rpcUrls` are not https, so a wallet reached over a plain-http LAN address can only add the demo
 * chain by hand; a wallet on `localhost` is unaffected.
 *
 * The add-chain request is sent with OUR params (`addEthereumChainParams`) rather than through
 * viem's `addChain` action, so the exact object a wallet receives is the one the unit tests pin.
 * Pure apart from the client it is handed — no React, no wallet context.
 */
import { numberToHex, type Chain, type Client, type Transport } from 'viem';
import { switchChain } from 'viem/actions';
import { chainEntry } from './chains';

/** EIP-3085 `wallet_addEthereumChain` parameter object. */
export interface AddEthereumChainParameter {
  chainId: `0x${string}`;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
}

/**
 * viem chain → the EIP-3085 object. `blockExplorerUrls` is omitted (not empty) when unknown.
 * `rpcUrls` is the chain's own (hostname-derived for local stacks) URLs.
 */
export function addEthereumChainParams(chain: Chain): AddEthereumChainParameter {
  const explorers = chain.blockExplorers ? Object.values(chain.blockExplorers).map((e) => e.url) : [];
  return {
    chainId: numberToHex(chain.id),
    chainName: chain.name,
    nativeCurrency: { ...chain.nativeCurrency },
    rpcUrls: [...chain.rpcUrls.default.http],
    ...(explorers.length ? { blockExplorerUrls: explorers } : {}),
  };
}

/**
 * Did the wallet say "I don't know that network"? EIP-3326 says 4902; MetaMask mobile nests it
 * inside a -32603, and viem wraps whatever it got — so walk the cause chain.
 */
export function isUnknownChain(err: unknown): boolean {
  const seen = new Set<unknown>();
  let node: unknown = err;
  while (node && typeof node === 'object' && !seen.has(node)) {
    seen.add(node);
    const e = node as { code?: unknown; message?: unknown; cause?: unknown; data?: { originalError?: unknown } };
    if (e.code === 4902) return true;
    if (typeof e.message === 'string' && /unrecognized chain|wallet_addEthereumChain/i.test(e.message)) return true;
    node = e.cause ?? e.data?.originalError;
  }
  return false;
}

export type SwitchOutcome = 'switched' | 'added';

/**
 * Switch `client`'s wallet to `chain`, adding the chain first if the wallet does not know it.
 * Anything other than "unknown chain" — a user rejection above all — is rethrown untouched.
 */
export async function switchWalletChain(client: Client<Transport, Chain | undefined>, chain: Chain): Promise<SwitchOutcome> {
  try {
    await switchChain(client, { id: chain.id });
  } catch (err) {
    if (!isUnknownChain(err)) throw err;
    await addEthereumChain(client, chain);
    // Most wallets switch as part of the add; asking again is harmless and covers the ones that do not.
    await switchChain(client, { id: chain.id });
    return 'added';
  }
  await refreshChainEntry(client, chain);
  return 'switched';
}

/** Send our EIP-3085 params. `retryCount: 0` — a wallet prompt is not something to resend on its own. */
async function addEthereumChain(client: Client<Transport, Chain | undefined>, chain: Chain): Promise<void> {
  await client.request(
    { method: 'wallet_addEthereumChain', params: [addEthereumChainParams(chain)] },
    { retryCount: 0 },
  );
}

/**
 * A chain whose RPC address is a moving target: only the local demo stack (`chainEntry.local`). Its
 * LAN address changes with DHCP, so a wallet entry pointing at an older one deserves the
 * best-effort refresh. Hosted chains have permanent URLs —
 * there is nothing to refresh.
 */
function hasMovableRpc(chain: Chain): boolean {
  return chainEntry(chain.id)?.local === true;
}

/**
 * Best-effort refresh of a chain the wallet already stores. An add never overwrites an entry the
 * user added by hand, but a wallet that added the network for this site can update its own entry
 * (MetaMask asks before doing so), which is what turns "press switch" into "the network RPC is
 * current again". Failure is ignored on purpose — the switch itself already succeeded, and the
 * UI's manual fallback covers the wallets that refuse. The wait is bounded too: an unanswered
 * prompt is abandoned, never waited on.
 */
async function refreshChainEntry(client: Client<Transport, Chain | undefined>, chain: Chain): Promise<void> {
  if (!hasMovableRpc(chain)) return;
  try {
    // The switch itself already succeeded: the refresh must never hold the switch UI hostage, so a
    // prompt the user leaves unanswered is abandoned after a short budget.
    await withTimeout(addEthereumChain(client, chain), REFRESH_ANSWER_TIMEOUT_MS, () => new Error('unanswered refresh'));
  } catch {
    // Ignored on purpose — see above.
  }
}

/**
 * EIP-3085 fields a visitor would type into a wallet by hand — same source as
 * `addEthereumChainParams`.
 */
export interface ManualNetworkParams {
  chainName: string;
  chainId: number;
  rpcUrl: string;
  currencySymbol: string;
}

export function manualNetworkParams(chain: Chain): ManualNetworkParams {
  return {
    chainName: chain.name,
    chainId: chain.id,
    rpcUrl: chain.rpcUrls.default.http[0] ?? '',
    currencySymbol: chain.nativeCurrency.symbol,
  };
}

/** 4001 anywhere in the cause chain (MetaMask mobile nests it the same way it nests 4902). */
export function isUserRejected(err: unknown): boolean {
  const seen = new Set<unknown>();
  let node: unknown = err;
  while (node && typeof node === 'object' && !seen.has(node)) {
    seen.add(node);
    const e = node as { code?: unknown; message?: unknown; cause?: unknown; data?: { originalError?: unknown } };
    if (e.code === 4001) return true;
    if (typeof e.message === 'string' && /user rejected|rejected the request/i.test(e.message)) return true;
    node = e.cause ?? e.data?.originalError;
  }
  return false;
}

/** How long a switch may wait for the wallet's answer before the app stops waiting. */
export const SWITCH_ANSWER_TIMEOUT_MS = 60_000;
/** A refresh of an entry the wallet already holds is best-effort: a short budget, then move on. */
const REFRESH_ANSWER_TIMEOUT_MS = 20_000;

/**
 * The wallet did not answer a switch within the budget. Nothing is cancelled — the wallet may
 * still confirm later, and its `chainChanged` keeps the app in step — the app just stops waiting,
 * so a prompt nobody answers can never pin the switch UI (the selector disables every row while a
 * switch is in flight).
 */
export class WalletSwitchTimeoutError extends Error {
  constructor() {
    super('The wallet did not answer the network switch in time.');
    this.name = 'WalletSwitchTimeoutError';
  }
}

/** Was this the bounded-wait timeout? Walks the cause chain like the other matchers. */
export function isWalletSwitchTimeout(err: unknown): boolean {
  const seen = new Set<unknown>();
  let node: unknown = err;
  while (node && typeof node === 'object' && !seen.has(node)) {
    seen.add(node);
    const e = node as { name?: unknown; cause?: unknown; data?: { originalError?: unknown } };
    if (e.name === 'WalletSwitchTimeoutError') return true;
    node = e.cause ?? e.data?.originalError;
  }
  return false;
}

/**
 * Resolve with `promise`, or reject with `onTimeout()` after `ms`. The underlying promise keeps
 * running — `Promise.race` holds handlers on it, so a late rejection cannot surface as unhandled.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * One sentence for a failed switch/add. A rejection and a bounded-wait timeout say so; anything
 * else ends with the manual parameters, because at that point only the user can add the network —
 * an add never overwrites an entry the wallet already stores.
 */
export function describeSwitchError(err: unknown, chain: Chain): string {
  if (isUserRejected(err)) return `The ${chain.name} switch was rejected in your wallet — press the button again when ready.`;
  if (isWalletSwitchTimeout(err)) {
    return `No answer from your wallet for the ${chain.name} switch — if a confirmation is waiting there, confirm it, then press the button again.`;
  }
  const e = err as { shortMessage?: string; message?: string } | null | undefined;
  const short = (e?.shortMessage ?? e?.message ?? String(err)).trim().replace(/[.\s]+$/, '');
  const p = manualNetworkParams(chain);
  return `Could not switch to ${chain.name}${short ? `: ${short}` : ''}. Add the network by hand if the wallet will not — RPC ${p.rpcUrl}, chain ID ${p.chainId}, symbol ${p.currencySymbol}.`;
}
