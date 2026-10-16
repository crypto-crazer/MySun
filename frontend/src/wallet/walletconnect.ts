/**
 * WalletConnect — the QR / mobile / desktop-app half of "all wallets".
 *
 * `@walletconnect/ethereum-provider` is a standalone EIP-1193 provider, so it plugs into the same
 * `createWalletClient({ transport: custom(provider) })` path as an injected wallet: no wagmi, no
 * connector abstraction.
 *
 * The rules this file exists to enforce:
 *  1. The project id is ALWAYS user-supplied (`VITE_WALLETCONNECT_PROJECT_ID`). Nothing is
 *     hardcoded; with no id the option is simply hidden.
 *  2. The module is only ever `import()`ed — it drags in a relay client and a QR modal, and it must
 *     not cost anything to a visitor who connects with a browser extension.
 *  3. v2's `request()` throws ("Please call connect() before request()") while no session exists,
 *     and only `connect()` opens the QR modal. `wrapWalletConnectProvider` restores the uniform
 *     provider semantics the rest of the app relies on: eth_requestAccounts = open the pairing UI
 *     and wait; eth_accounts is silent and empty until a session exists.
 *  4. v2's own `provider.accounts` is NOT trustworthy. Its `setAccounts` keeps only accounts whose
 *     chain matches a *persisted* chainId (IndexedDB), so a restored session — or one whose stored
 *     chain no longer lines up with the session's accounts — reports ZERO accounts while holding a
 *     perfectly good address: the app then says "WalletConnect returned no account." We derive
 *     accounts from the SESSION itself instead, and treat a session without any usable account as
 *     broken: drop it and pair again, once.
 */
import type { EIP1193Provider } from 'viem';
import { DEFAULT_CHAIN_ID, SUPPORTED_CHAINS } from '@/chain/chains';
import {
  SWITCH_ANSWER_TIMEOUT_MS,
  WalletSwitchTimeoutError,
  isUserRejected,
  isWalletSwitchTimeout,
  withTimeout,
} from '@/chain/switchChain';
import { BRAND } from '@/lib/brand';

/** Empty string when unset — the picker hides WalletConnect rather than failing at click time. */
export const WALLETCONNECT_PROJECT_ID: string = (
  import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? ''
).trim();

export const walletConnectEnabled = WALLETCONNECT_PROJECT_ID.length > 0;

let pending: Promise<EIP1193Provider> | undefined;

/** The universal-provider internals this file reaches into for the wallet-side switch. */
type SignerInternals = {
  namespace?: { chains?: readonly string[] };
  client?: { request?: (args: unknown) => Promise<unknown> };
};

/** The parts of `EthereumProvider` this wrapper relies on (kept structural, so it can be tested). */
export type WalletConnectProviderLike = {
  session?: unknown;
  accounts?: readonly string[];
  connect: () => Promise<unknown>;
  disconnect?: () => Promise<void>;
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  /** Present on a real `EthereumProvider`; absent in minimal fakes. */
  signer?: SignerInternals;
};

type SessionNamespace = { accounts?: unknown };

/**
 * The session's own accounts (CAIP-10 `eip155:<chainId>:<address>`), order-stable and
 * de-duplicated by address. Reads both namespace layouts the SDK has shipped: inline (`eip155`)
 * and nested (`eip155:<chainId>`). This — not `provider.accounts` — is the truth about which
 * address the wallet authorised (see rule 4).
 */
export function accountsFromSession(provider: WalletConnectProviderLike): string[] {
  const namespaces = (
    provider.session as { namespaces?: Record<string, SessionNamespace> } | undefined
  )?.namespaces;
  if (!namespaces) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [key, namespace] of Object.entries(namespaces)) {
    if (key !== 'eip155' && !key.startsWith('eip155:')) continue;
    const accounts = Array.isArray(namespace?.accounts) ? namespace.accounts : [];
    for (const entry of accounts) {
      if (typeof entry !== 'string') continue;
      const address = entry.includes(':') ? entry.split(':')[2] : entry;
      if (!address) continue;
      const fingerprint = address.toLowerCase();
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      out.push(address);
    }
  }
  return out;
}

/** Session first (rule 4); `provider.accounts` only as a last resort. */
function usableAccounts(provider: WalletConnectProviderLike): string[] {
  const fromSession = accountsFromSession(provider);
  if (fromSession.length) return fromSession;
  return [...(provider.accounts ?? [])];
}

/**
 * Wrap a v2 provider so `eth_requestAccounts` means "connect me" (open the QR modal, wait for the
 * pairing) like it does for an injected wallet — without a session, v2's own `request()` throws.
 * `eth_accounts` answers `[]` until a session exists, matching what an injected wallet would say.
 */
export function wrapWalletConnectProvider(provider: WalletConnectProviderLike): EIP1193Provider {
  return new Proxy(provider as unknown as EIP1193Provider, {
    get(target, prop) {
      if (prop === 'request') {
        return async (args: { method: string; params?: unknown }) => {
          if (args.method === 'eth_accounts') {
            if (!provider.session) return [];
            return usableAccounts(provider);
          }
          if (args.method === 'eth_requestAccounts') {
            if (!provider.session) await provider.connect();
            if (!provider.session) {
              throw new Error('WalletConnect: the pairing was not completed — please try again.');
            }
            let accounts = usableAccounts(provider);
            if (!accounts.length) {
              // A session without a usable account is dead weight (rule 4): drop it and pair
              // again once, rather than reporting a connected wallet with no address.
              if (typeof provider.disconnect === 'function') {
                try {
                  await provider.disconnect();
                } catch {
                  /* re-pairing below is the goal; a refused teardown must not block it */
                }
              }
              await provider.connect();
              accounts = usableAccounts(provider);
              if (!accounts.length) throw new Error('WalletConnect returned no account.');
            }
            return accounts;
          }
          if (args.method === 'wallet_switchEthereumChain') {
            const params = Array.isArray(args.params) ? [...(args.params as unknown[])] : [];
            const first = (params[0] ?? {}) as { chainId?: unknown };
            const fixed = fixSwitchChainId(first.chainId);
            // Junk (`NaN` — what EP's own chainChanged handler used to echo) has nothing to switch.
            if (fixed === undefined) return null;
            const target = `eip155:${Number.parseInt(fixed, 16)}`;
            if (approvedChainIds(provider).includes(target)) {
              // UP answers a switch to a session chain LOCALLY — the wallet is never asked, so a
              // wallet sitting on another chain stays there and "Switch" looks dead (reproduced
              // live). Ask the wallet itself first; the normal request below then keeps the SDK's
              // own bookkeeping (setDefaultChain) in step.
              try {
                await requestSwitchThroughWallet(provider, fixed);
              } catch (err) {
                if (isUserRejected(err) || isWalletSwitchTimeout(err)) throw err;
                // Any other answer — wallets differ — falls back to the SDK's handling.
              }
            }
            params[0] = { ...first, chainId: fixed };
            return provider.request({ ...args, params });
          }
          return provider.request(args);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * One CAIP namespace as `@walletconnect/ethereum-provider` shapes it when it calls
 * `signer.connect` (the subset this file touches).
 */
type ConnectNamespace = {
  chains?: readonly string[];
  methods?: readonly string[];
  events?: readonly string[];
  rpcMap?: Record<string, string>;
  [key: string]: unknown;
};

/** The argument `EthereumProvider` hands `signer.connect` — plus keys a future version may use. */
export type ConnectNamespacesArgs = {
  namespaces?: Record<string, ConnectNamespace>;
  requiredNamespaces?: Record<string, ConnectNamespace>;
  optionalNamespaces?: Record<string, ConnectNamespace>;
  [key: string]: unknown;
};

const dedupe = (values: readonly string[]): string[] => [...new Set(values)];

/**
 * EP v2.25 hands its connect namespaces to universal-provider as `namespaces` (the chain IT calls
 * required) plus `optionalNamespaces`. UP v2.25's `setNamespaces` folds the former into the latter
 * with `w(namespaces, optionalNamespaces)` — and that merge REPLACES the `chains` array of a
 * namespace both inputs touch instead of unioning it. Result: whenever both objects cover eip155,
 * the chain from `namespaces` (the default — eip155:46630, the Demo Chain) silently vanishes from
 * the proposal. Wallet sessions could never include it, which is why "switch to Demo Chain" was
 * impossible over WalletConnect even for wallets that KNOW the chain, and the phone stayed on its
 * own network ("Chain 1").
 *
 * Fold every namespace input into ONE `optionalNamespaces` object — chains/methods/events unioned,
 * first-seen order kept — and drop `namespaces`/`requiredNamespaces`. Optional-only is also the
 * shape the Reown modal itself proposes: a wallet that knows the chain can offer it, and a wallet
 * that does not is still free to connect (and is then told to add the chain).
 */
export function mergeConnectNamespaces<T extends ConnectNamespacesArgs>(args: T): T {
  const inputs = [args.namespaces, args.requiredNamespaces, args.optionalNamespaces].filter(
    (ns): ns is Record<string, ConnectNamespace> => !!ns && Object.keys(ns).length > 0,
  );
  if (!inputs.length) return args;

  const merged: Record<string, ConnectNamespace> = {};
  for (const input of inputs) {
    for (const [key, value] of Object.entries(input)) {
      const current = merged[key];
      merged[key] = {
        ...current,
        ...value,
        chains: dedupe([...(current?.chains ?? []), ...(value.chains ?? [])]),
        methods: dedupe([...(current?.methods ?? []), ...(value.methods ?? [])]),
        events: dedupe([...(current?.events ?? []), ...(value.events ?? [])]),
        rpcMap: { ...(current?.rpcMap ?? {}), ...(value.rpcMap ?? {}) },
      };
    }
  }

  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key !== 'namespaces' && key !== 'requiredNamespaces') rest[key] = value;
  }
  rest.optionalNamespaces = merged;
  return rest as T;
}

/**
 * The chain id inside a CAIP-2 string, as a clean `eip155:<decimal>` — or undefined when the value
 * is not a chain id at all. Covers what the layers above actually produce: `eip155:46630`
 * (decimal), `eip155:0xb626` (hex), a double-prefixed `eip155:eip155:46630` (EP v2.25 applies its
 * own `formatChainId` to already-CAIP chainChanged data), and junk like `eip155:NaN`.
 */
export function normalizeChainIdInput(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const raw = (value.split(':').pop() ?? '').trim();
  if (!raw) return undefined;
  const parsed = /^0x[0-9a-f]+$/i.test(raw) ? Number.parseInt(raw, 16) : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return `eip155:${parsed}`;
}

/**
 * EIP-3326 wants a 0x-prefixed hex chain id; two upstream producers do not deliver one. EP v2.25's
 * `switchEthereumChain` sends `(46630).toString(16)` — `"b626"` — and its chainChanged handler can
 * emit `NaN` outright. Bare values here always come from that `toString(16)` path, so they are
 * read as hex; anything unparseable is dropped (the wallet is already on the chain the event
 * announced — there is nothing to switch).
 */
export function fixSwitchChainId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  if (/^0x[0-9a-f]+$/i.test(value)) return value;
  if (/^[0-9a-f]+$/i.test(value)) return `0x${value}`;
  return undefined;
}

/** The session's chains as CAIP-2 ids — UP's own `namespace` first, the session as fallback. */
export function approvedChainIds(provider: WalletConnectProviderLike): readonly string[] {
  const direct = provider.signer?.namespace?.chains;
  if (Array.isArray(direct) && direct.length) return direct;
  const fromSession = (
    provider.session as { namespaces?: Record<string, { chains?: readonly string[] }> } | undefined
  )?.namespaces?.eip155?.chains;
  return Array.isArray(fromSession) ? fromSession : [];
}

/**
 * Ask the WALLET itself to move, through the live session, instead of letting universal-provider
 * answer the switch on its own. UP treats a switch to a session chain as pure bookkeeping
 * (`setDefaultChain` — the wallet is never asked; notes/WALLETS.md), so a wallet that is on another
 * chain simply does not move: press "Switch" and the app looks switched while the wallet does not.
 * Sending the request through the session makes the wallet move; its `chainChanged` then updates
 * the SDK state, and the normal request that follows keeps the local bookkeeping in step.
 * Rejections and the bounded-wait timeout propagate (the user must hear about both — the selector
 * disables every row while a switch is in flight, so "no answer" cannot be waited on forever); no
 * session or no route resolves quietly.
 */
export async function requestSwitchThroughWallet(
  provider: WalletConnectProviderLike,
  chainIdHex: string,
): Promise<void> {
  const session = provider.session as { topic?: string } | undefined;
  const client = provider.signer?.client;
  const route = approvedChainIds(provider)[0];
  if (!session?.topic || !client?.request || !route) return;
  // Bounded on purpose: the selector disables every row while a switch is in flight, so a wallet
  // that never answers must not pin the UI. The request itself is not cancelled — a late
  // confirmation still reaches the app through the wallet's `chainChanged`.
  await withTimeout(
    client.request({
      topic: session.topic,
      request: { method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] },
      chainId: route,
    }),
    SWITCH_ANSWER_TIMEOUT_MS,
    () => new WalletSwitchTimeoutError(),
  );
}

/**
 * Initialise (once) and return the WalletConnect provider. `init` also restores an existing
 * session from local storage, which is how WalletConnect reconnects across a reload.
 */
export function loadWalletConnect(): Promise<EIP1193Provider> {
  if (!walletConnectEnabled) {
    return Promise.reject(
      new Error('WalletConnect is not configured: set VITE_WALLETCONNECT_PROJECT_ID in .env.local.'),
    );
  }
  pending ??= (async () => {
    const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
    const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
    const provider = await EthereumProvider.init({
      projectId: WALLETCONNECT_PROJECT_ID,
      // The default chain is required; every other registry chain is optional, so a wallet that
      // cannot add the local node can still connect and be told to switch.
      chains: [DEFAULT_CHAIN_ID],
      optionalChains: SUPPORTED_CHAINS.map((c) => c.id).filter((id) => id !== DEFAULT_CHAIN_ID),
      rpcMap: Object.fromEntries(SUPPORTED_CHAINS.map((c) => [c.id, c.rpcUrls.default.http[0]])),
      showQrModal: true,
      metadata: {
        name: BRAND.name,
        description: 'In-kind, multi-pool LP auto-rebalance vault',
        url: origin,
        icons: [`${origin}/favicon.svg`],
      },
    });
    // v2 refuses request() before a session (rule 3) — hand out the uniform semantics instead.
    // Two more v2.25 quirks get patched here so the wallet sees sane traffic (details on each
    // helper, and at mergeConnectNamespaces):
    //  1. the connect proposal drops EP's default chain — merge everything into optionalNamespaces;
    //  2. the chainChanged handler corrupts chain ids (`eip155:eip155:46630` → `NaN`) and its
    //     echo-switch lacks the 0x prefix — normalise both, and never bounce a switch back.
    const internals = provider as unknown as {
      chainId?: number;
      setChainId?: (value: string) => void;
      signer?: {
        connect?: (args: ConnectNamespacesArgs) => unknown;
        request?: (args: unknown, ...rest: unknown[]) => Promise<unknown>;
        namespaces?: unknown;
      };
    };
    const signer = internals.signer;
    if (signer && typeof signer.connect === 'function') {
      const connect = signer.connect.bind(signer);
      signer.connect = (args: ConnectNamespacesArgs) => {
        // UP rehydrates `namespaces` from storage keyed by the CURRENT session topic, so a
        // lingering session's chains would re-enter the next pairing as `requiredNamespaces`.
        // A fresh proposal must stand on its own: clear it, and let the merged optional set speak.
        signer.namespaces = {};
        return connect(mergeConnectNamespaces(args ?? {}));
      };
    }
    if (typeof internals.setChainId === 'function') {
      const setChainId = internals.setChainId.bind(provider);
      internals.setChainId = (value: string) => {
        const normalized = normalizeChainIdInput(value);
        // Unparseable input would set `chainId = NaN` upstream; keeping the last good value beats
        // corrupting every later read of the connection's chain.
        if (normalized !== undefined) setChainId(normalized);
      };
    }
    if (signer && typeof signer.request === 'function') {
      const request = signer.request.bind(signer);
      signer.request = (args: unknown, ...rest: unknown[]) => {
        const call = (typeof args === 'string' ? { method: args } : args) as
          | { method?: string; params?: unknown }
          | undefined;
        if (call?.method === 'wallet_switchEthereumChain') {
          const params = Array.isArray(call.params) ? [...(call.params as unknown[])] : [];
          const first = (params[0] ?? {}) as { chainId?: unknown };
          const fixed = fixSwitchChainId(first.chainId);
          // Unparseable junk (the NaN EP used to emit here) is dropped rather than forwarded;
          // everything else — including a switch to the chain we believe we are on — MUST reach
          // the wallet: the provider's own `chainId` can be stale (restored session), and eating
          // the request would silently strand the user on the wallet's real chain.
          if (fixed === undefined) return Promise.resolve(null);
          params[0] = { ...first, chainId: fixed };
          return request({ ...call, params }, ...rest);
        }
        return request(args, ...rest);
      };
    }
    return wrapWalletConnectProvider(provider as unknown as WalletConnectProviderLike);
  })();
  return pending;
}

/**
 * The accounts of a WalletConnect session that already exists (used for the silent reconnect on
 * reload). Session-derived for the same reason as rule 4 — `provider.accounts` can read empty
 * while the session is fine.
 */
export function walletConnectAccounts(provider: EIP1193Provider): readonly string[] {
  return usableAccounts(provider as unknown as WalletConnectProviderLike);
}

/** WalletConnect needs an explicit teardown; an injected provider does not. */
export async function closeWalletConnect(provider: EIP1193Provider): Promise<void> {
  const closable = provider as unknown as { disconnect?: () => Promise<void> };
  if (typeof closable.disconnect === 'function') await closable.disconnect();
  pending = undefined;
}
