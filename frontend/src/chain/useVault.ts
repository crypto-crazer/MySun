/**
 * Live reads of the deployed MySun vault.
 *
 * Every read targets the vault a page names — its chain and registry entry (`useLiveVaultAt`) — so the
 * live vault renders even with no wallet connected (or a wallet on another network) — only writes
 * need the wallet on the right chain. Every read is cache-keyed by that vault's address, so switching
 * vaults never shows the previous vault's numbers. On a chain with no deployment every read is
 * disabled and `hasDeployment` is false; callers render that state.
 *
 * What the chain gives us here, and nothing more: basket tokens, totals (idle + adapter positions),
 * receipt-token supply and balances, the in-kind redeem preview, the performance fee, the paused flag and
 * the adapter list — plus, where the chain lists zap periphery, the zap facets' availability and quotes
 * (`useZapRoutes`, `usePreviewZap`, `usePreviewZapRedeem`). No USD, no APR, no oracle: those are demo
 * data (src/demo) and are labelled.
 */
import { useMemo, useRef } from 'react';
import type { Address } from 'viem';
import { erc20Abi } from 'viem';
import { vaultAbi, positionAdapterAbi, mockAdapterAbi, zapInAbi, zapOutAbi } from '@/config/generated';
import { callsKey, type ContractCall, type ReadResult } from './client';
import { deploymentForChain, type ChainDeployment, type VaultEntry } from './chains';
import { pick, useReads } from './useReads';
import { shortHex } from './amounts';
import type { CatalogVault } from './useVaultCatalog';
import { isZapRouteSymbol, zapInCallAbi, zapOutCallAbi } from './zap';

/**
 * Placeholder for reads that are disabled anyway: the wallet-scoped ones while no wallet is
 * connected, and the vault address on a chain with no deployment. Never sent to a node.
 */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

/** The vault as a read target: where it lives, and whether there is anything to read at all. */
type VaultTarget = Pick<LiveVault, 'address' | 'chainId' | 'hasDeployment'>;

/** Fallback receipt label when neither the chain nor the registry has answered (no deployment). */
const DEFAULT_RECEIPT = { name: 'sunEthLP', symbol: 'sunEthLP' } as const;

const vaultContract = (vault: Pick<LiveVault, 'address'>) => ({ address: vault.address, abi: vaultAbi }) as const;

export interface TokenMeta {
  address: Address;
  /** On-chain symbol (the short address only when its `symbol()` read failed). */
  symbol: string;
  decimals: number;
}

export interface AdapterReport {
  address: Address;
  dex: string;
  poolId: string;
  /** position() amounts aligned to the vault's registry token order (0 where not reported). */
  position: bigint[];
  /** MockPositionAdapter-only extras; undefined against a real adapter. */
  deployed?: bigint[];
  harvestable?: bigint[];
  /** position() reverted (a real adapter may be unable to report; redeem never depends on it). */
  reportFailed: boolean;
}

export interface LiveVault {
  /** The vault on `chainId`; the zero address (and every read disabled) when `hasDeployment` is false. */
  address: Address;
  chainId: number;
  deployment: ChainDeployment | undefined;
  /** The vault's registry entry (key, label, configured receipt); undefined without a deployment. */
  entry: VaultEntry | undefined;
  hasDeployment: boolean;
  /** `name()` / `symbol()` as read from the chain; undefined until the read lands. */
  name?: string;
  symbol?: string;
  /** The receipt token to display: the chain's name/symbol, else the registry's, else "sunEthLP". */
  receipt: { name: string; symbol: string };
  decimals: number;
  /** The basket, once its symbols and decimals are known (empty until then). */
  tokens: TokenMeta[];
  /** Per token: idle + everything the adapters hold, aligned to the vault's token order. */
  totals: bigint[];
  /** Per token: the vault's own ERC-20 balance. */
  idle: bigint[];
  /** Per token: totals − idle. */
  inPosition: bigint[];
  totalSupply: bigint;
  performanceFeeBps: number;
  paused: boolean;
  owner?: Address;
  treasury?: Address;
  adapters: AdapterReport[];
  isLoading: boolean;
  /** RPC unreachable or the vault is not deployed at this address. */
  error: Error | null;
  refetch: () => void;
}

/**
 * What the catalogue (src/chain/useVaultCatalog.ts) already read for a vault: the card seeds from it, so the
 * overlay and the vault page draw the basket — and start the zap probe — in their first frame instead of
 * waiting for their own reads of the same data.
 */
export type VaultSeed = Pick<CatalogVault, 'address' | 'ready' | 'tokens' | 'supply' | 'paused' | 'decimals' | 'performanceFeeBps'>;

const sameAddresses = (a: readonly Address[], b: readonly Address[]) => a.length === b.length && a.every((x, i) => x.toLowerCase() === b[i].toLowerCase());

/**
 * Vault-wide state of ONE registry vault, named by its chain and entry — the vault page and the
 * deposit overlay read the vault in their URL, whatever the header or the wallet is pointed at.
 * Safe to call without a wallet; `entry` undefined = no deployment (every read disabled).
 *
 * `seed` (the catalogue's row for the same vault) stands in until the vault's own reads land; its token
 * symbols and decimals — which never change — are used as they are, not read a second time. `tokens` is
 * empty until symbols and decimals are known: never a placeholder symbol or assumed decimals.
 */
export function useLiveVaultAt(chainId: number, entry: VaultEntry | undefined, seed?: VaultSeed): LiveVault {
  const deployment = deploymentForChain(chainId);
  const hasDeployment = deployment !== undefined && entry !== undefined;
  const address = (entry?.vault ?? ZERO_ADDRESS) as Address;
  const vault = vaultContract({ address });
  const seeded = seed?.ready && seed.address.toLowerCase() === address.toLowerCase() ? seed : undefined;

  const basics = useReads(
    [
      { ...vault, functionName: 'tokens' },
      { ...vault, functionName: 'totalTokens' },
      { ...vault, functionName: 'totalSupply' },
      { ...vault, functionName: 'performanceFeeBps' },
      { ...vault, functionName: 'paused' },
      { ...vault, functionName: 'adapters' },
      { ...vault, functionName: 'name' },
      { ...vault, functionName: 'symbol' },
      { ...vault, functionName: 'decimals' },
      { ...vault, functionName: 'owner' },
      { ...vault, functionName: 'treasury' },
    ],
    { chainId, scope: address, enabled: hasDeployment },
  );

  const tokenAddresses = pick<readonly Address[]>(basics.data, 0) ?? seeded?.tokens.map((t) => t.address) ?? [];
  const totalsRaw = pick<readonly [readonly Address[], readonly bigint[]]>(basics.data, 1);
  const adapterAddresses = pick<readonly Address[]>(basics.data, 5) ?? [];
  // The catalogue's metadata, when it describes this very basket
  const known = seeded && sameAddresses(seeded.tokens.map((t) => t.address), tokenAddresses) ? seeded.tokens : undefined;
  // The catalogue rebuilds its rows every render: memoise on their content, not their identity
  const knownKey = known?.map((t) => `${t.symbol}:${t.decimals}:${t.total}`).join(',');

  // Per token: the vault's own (idle) balance, plus symbol + decimals unless the catalogue already has them.
  const stride = known ? 1 : 3;
  const tokenReads = useReads(
    tokenAddresses.flatMap((t) => [
      ...(known
        ? []
        : [
            { address: t, abi: erc20Abi, functionName: 'symbol' } as const,
            { address: t, abi: erc20Abi, functionName: 'decimals' } as const,
          ]),
      { address: t, abi: erc20Abi, functionName: 'balanceOf', args: [address] } as const,
    ]),
    { chainId, scope: address, enabled: hasDeployment && tokenAddresses.length > 0 },
  );
  // The metadata reads have answered (a whole-batch failure too: the tokens then go by their addresses)
  const metaSettled = tokenReads.data !== undefined || tokenReads.error !== null;

  const tokens: TokenMeta[] = useMemo(
    () =>
      known
        ? known.map((t) => ({ address: t.address, symbol: t.symbol, decimals: t.decimals }))
        : !metaSettled
          ? []
          : tokenAddresses.map((address, i) => ({
              address,
              // The short address only for a token whose symbol() read failed
              symbol: pick<string>(tokenReads.data, i * stride) ?? shortHex(address),
              decimals: Number(pick<number>(tokenReads.data, i * stride + 1) ?? 18),
            })),
    [tokenAddresses.join(','), tokenReads.data, knownKey, metaSettled],
  );

  const idle = useMemo(
    () => tokenAddresses.map((_, i) => pick<bigint>(tokenReads.data, i * stride + stride - 1) ?? 0n),
    [tokenAddresses.join(','), tokenReads.data, stride],
  );

  const totals = useMemo(() => {
    if (!totalsRaw) return known ? known.map((t) => t.total) : tokenAddresses.map(() => 0n);
    const [, amounts] = totalsRaw;
    return tokenAddresses.map((_, i) => amounts[i] ?? 0n);
  }, [totalsRaw, tokenAddresses.join(','), knownKey]);

  const adapters = useAdapterReports(chainId, address, adapterAddresses, tokenAddresses);

  const refetch = () => {
    basics.refetch();
    tokenReads.refetch();
    adapters.refetch();
  };

  const name = pick<string>(basics.data, 6);
  const symbol = pick<string>(basics.data, 7);

  return {
    address,
    chainId,
    deployment,
    entry,
    hasDeployment,
    name,
    symbol,
    receipt: {
      name: name ?? entry?.receipt.name ?? DEFAULT_RECEIPT.name,
      symbol: symbol ?? entry?.receipt.symbol ?? DEFAULT_RECEIPT.symbol,
    },
    decimals: Number(pick<number>(basics.data, 8) ?? seeded?.decimals ?? 18),
    tokens,
    totals,
    idle,
    inPosition: totals.map((t, i) => {
      const rest = t - (idle[i] ?? 0n);
      return rest > 0n ? rest : 0n;
    }),
    totalSupply: pick<bigint>(basics.data, 2) ?? seeded?.supply ?? 0n,
    performanceFeeBps: Number(pick<number>(basics.data, 3) ?? seeded?.performanceFeeBps ?? 0),
    paused: pick<boolean>(basics.data, 4) ?? seeded?.paused ?? false,
    owner: pick<Address>(basics.data, 9),
    treasury: pick<Address>(basics.data, 10),
    adapters: adapters.reports,
    // Still loading while the basket's addresses are known but not yet their symbols and decimals
    isLoading: (basics.isLoading && !seeded) || (tokenAddresses.length > 0 && tokens.length === 0),
    error: basics.error,
    refetch,
  };
}

/**
 * Per-adapter reports. `dex`/`poolId`/`position` are the IPositionAdapter surface; `deployed(i)` and
 * `harvestable(i)` only exist on the mock — they are requested opportunistically and a failure just
 * leaves them undefined.
 */
function useAdapterReports(
  chainId: number,
  vaultAddress: Address,
  adapterAddresses: readonly Address[],
  tokenAddresses: readonly Address[],
): { reports: AdapterReport[]; refetch: () => void } {
  const n = tokenAddresses.length;
  const perAdapter = 3 + n * 2;

  const reads = useReads(
    adapterAddresses.flatMap((a) => [
      { address: a, abi: positionAdapterAbi, functionName: 'dex' } as const,
      { address: a, abi: positionAdapterAbi, functionName: 'poolId' } as const,
      { address: a, abi: positionAdapterAbi, functionName: 'position' } as const,
      ...Array.from({ length: n }, (_, i) => ({
        address: a,
        abi: mockAdapterAbi,
        functionName: 'deployed',
        args: [BigInt(i)],
      }) as const),
      ...Array.from({ length: n }, (_, i) => ({
        address: a,
        abi: mockAdapterAbi,
        functionName: 'harvestable',
        args: [BigInt(i)],
      }) as const),
    ]),
    { chainId, scope: vaultAddress, enabled: adapterAddresses.length > 0 && n > 0 },
  );

  const reports = useMemo(
    () =>
      adapterAddresses.map((address, ai): AdapterReport => {
        const base = ai * perAdapter;
        const position = pick<readonly [readonly Address[], readonly bigint[]]>(reads.data, base + 2);
        // Align the adapter's own token order onto the vault registry order.
        const aligned = tokenAddresses.map((t) => {
          if (!position) return 0n;
          const [ptokens, amounts] = position;
          const idx = ptokens.findIndex((p) => p.toLowerCase() === t.toLowerCase());
          return idx === -1 ? 0n : (amounts[idx] ?? 0n);
        });
        const deployed = tokenAddresses.map((_, i) => pick<bigint>(reads.data, base + 3 + i));
        const harvestable = tokenAddresses.map((_, i) => pick<bigint>(reads.data, base + 3 + n + i));
        const hasDeployed = deployed.every((v) => v !== undefined);
        const hasHarvestable = harvestable.every((v) => v !== undefined);
        return {
          address,
          dex: pick<string>(reads.data, base) ?? '',
          poolId: pick<string>(reads.data, base + 1) ?? '',
          position: aligned,
          deployed: hasDeployed ? (deployed as bigint[]) : undefined,
          harvestable: hasHarvestable ? (harvestable as bigint[]) : undefined,
          reportFailed: !position,
        };
      }),
    [adapterAddresses.join(','), tokenAddresses.join(','), reads.data, perAdapter, n],
  );

  return { reports, refetch: reads.refetch };
}

export interface UserBasket {
  /** Receipt-token (the vault's own symbol) balance. */
  shares: bigint;
  /** previewRedeem(shares) per registry token — what the wallet could pull out right now. */
  owed: bigint[];
  /** Wallet balance per registry token. */
  balances: bigint[];
  /** allowance(wallet → vault) per registry token. */
  allowances: bigint[];
  isLoading: boolean;
  refetch: () => void;
}

/**
 * Everything that depends on the connected wallet, on the vault's chain. Returns zeros when
 * disconnected or when that chain has no deployment.
 */
export function useUserBasket(account: Address | undefined, vault: VaultTarget & Pick<LiveVault, 'tokens'>): UserBasket {
  const { chainId, tokens } = vault;
  const enabled = Boolean(account) && vault.hasDeployment;

  const shareRead = useReads(
    account ? [{ ...vaultContract(vault), functionName: 'balanceOf', args: [account] }] : [],
    { chainId, scope: vault.address, enabled },
  );
  const shares = pick<bigint>(shareRead.data, 0) ?? 0n;

  const previewRead = useReads([{ ...vaultContract(vault), functionName: 'previewRedeem', args: [shares] }], {
    chainId,
    scope: vault.address,
    enabled: enabled && shares > 0n,
  });

  const walletReads = useReads(
    tokens.flatMap((t) => [
      { address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [account ?? ZERO_ADDRESS] } as const,
      { address: t.address, abi: erc20Abi, functionName: 'allowance', args: [account ?? ZERO_ADDRESS, vault.address] } as const,
    ]),
    { chainId, scope: vault.address, enabled: enabled && tokens.length > 0 },
  );

  const preview = pick<readonly [readonly Address[], readonly bigint[]]>(previewRead.data, 0);

  const owed = useMemo(() => tokens.map((_, i) => preview?.[1]?.[i] ?? 0n), [preview, tokens.length]);
  const balances = useMemo(
    () => tokens.map((_, i) => pick<bigint>(walletReads.data, i * 2) ?? 0n),
    [walletReads.data, tokens.length],
  );
  const allowances = useMemo(
    () => tokens.map((_, i) => pick<bigint>(walletReads.data, i * 2 + 1) ?? 0n),
    [walletReads.data, tokens.length],
  );

  return {
    shares,
    owed,
    balances,
    allowances,
    isLoading: shareRead.isLoading || walletReads.isLoading,
    refetch: () => {
      shareRead.refetch();
      previewRead.refetch();
      walletReads.refetch();
    },
  };
}

/** `previewDeposit(tokens, amounts)` — reverts exactly as `deposit` would, so errors are surfaced. */
export function usePreviewDeposit(vault: VaultTarget, tokens: readonly Address[], amounts: readonly bigint[], enabled: boolean) {
  const read = useReads(
    [{ ...vaultContract(vault), functionName: 'previewDeposit', args: [tokens as Address[], amounts as bigint[]] }],
    { chainId: vault.chainId, scope: vault.address, enabled: vault.hasDeployment && enabled && tokens.length > 0, retry: false },
  );
  const data = pick<readonly [bigint, readonly bigint[]]>(read.data, 0);
  return {
    shares: data?.[0],
    required: data?.[1] ? [...data[1]] : undefined,
    error: read.error,
    isLoading: read.isFetching,
    refetch: read.refetch,
  };
}

/** A zap facet the vault can offer: the periphery contract and the single token it routes. */
export interface ZapRoute {
  zap: Address;
  /** The route token: what a zap-in takes (any basket token with a full route set) and a zap-out pays (USDG). */
  token: TokenMeta;
  /** Its index in the vault registry. */
  index: number;
  /** The loosest route's `maxSlippageBps` (on-chain `routes()`): the most any swap leg may slip — the zap sends
   *  `ZAP_LEG_SLIPPAGE_BPS` = 0, so each leg is bounded by its own route's cap (display only). */
  maxLegSlippageBps: number;
}

/**
 * Where a zap facet's probe stands:
 *  - `idle`: nothing to probe — no periphery on the chain, or a basket without USDG (owner decision: no facet);
 *  - `probing`: the vault's tokens or the probe itself have not landed yet ("not confirmed yet");
 *  - `served` / `not-served`: settled (a probe that never succeeded counts as not served).
 */
export type ZapStatus = 'idle' | 'probing' | 'served' | 'not-served';

export interface ZapRoutes {
  /** The zap-in candidates — every basket token with a route to EVERY other one — USDG (the default) first; empty unless served. */
  zapIn: ZapRoute[];
  /** The zap-out facet (always into USDG). */
  zapOut?: ZapRoute;
  zapInStatus: ZapStatus;
  zapOutStatus: ZapStatus;
}

type ReadsData = ReturnType<typeof useReads>['data'];

/**
 * `data` with each failed call replaced by that call's last SUCCESSFUL result, so one rejected read in a
 * poll does not flip a confirmed route off (and unmount the form built on it). Only a successful read can
 * change a value — e.g. one that says unregistered / zero route. Keyed by chain + scope + call.
 */
function useLastGood(calls: readonly ContractCall[], data: ReadsData, chainId: number, scope: string): ReadsData {
  const store = useRef(new Map<string, ReadResult>());
  const keys = calls.map((c) => `${chainId}|${scope.toLowerCase()}|${callsKey([c])}`);
  if (!data) {
    // Nothing landed yet (or the whole query failed with no data): only what this exact call set had before.
    const kept = keys.map((k) => store.current.get(k));
    return kept.every((r) => r !== undefined) && kept.length > 0 ? (kept as ReadResult[]) : undefined;
  }
  return data.map((r, i) => {
    const k = keys[i];
    if (r.status === 'success') {
      store.current.set(k, r);
      return r;
    }
    return store.current.get(k) ?? r;
  });
}

/**
 * Which zap facets the vault has. A facet exists only when the CHAIN lists the periphery
 * contract (planned chains list none), the basket holds USDG, the zap has this vault registered, and the
 * routes are complete: a zap-in candidate is any basket token with a route to every other basket token
 * (USDG first — the deposit default); the zap-out needs a route from every other token into USDG.
 * The statuses tell "not confirmed yet" from "not served", and a confirmed route survives a transient
 * per-call read failure (`useLastGood`).
 */
export function useZapRoutes(vault: LiveVault): ZapRoutes {
  const periphery = vault.deployment?.periphery;
  const tokens = vault.tokens;
  // The tokens' symbols are what finds USDG: until they land USDG is "not resolved yet"
  const resolving = vault.hasDeployment && (vault.isLoading || (tokens.length === 0 && !vault.error));
  // Remember where USDG sat, so a symbol read failing in one poll does not lose it
  const usdgSeen = useRef(new Map<string, Address>());
  const scopeKey = `${vault.chainId}|${vault.address.toLowerCase()}`;
  let usdg = tokens.findIndex((t) => isZapRouteSymbol(t.symbol));
  if (usdg !== -1) usdgSeen.current.set(scopeKey, tokens[usdg].address);
  else {
    const seen = usdgSeen.current.get(scopeKey);
    usdg = seen ? tokens.findIndex((t) => t.address === seen && t.symbol === shortHex(t.address)) : -1;
  }
  const anchor = usdg === -1 ? undefined : tokens[usdg];

  // Zap-in: every ORDERED pair of basket tokens (from → to); zap-out: every other token → USDG.
  const pairs = anchor ? tokens.flatMap((_, a) => tokens.flatMap((__, b) => (a === b ? [] : [[a, b] as const]))) : [];
  const outFrom = anchor ? tokens.map((_, i) => i).filter((i) => i !== usdg) : [];

  const inCalls: ContractCall[] = periphery?.zapIn && anchor
    ? [
        { address: periphery.zapIn, abi: zapInAbi, functionName: 'isVaultRegistered', args: [vault.address] },
        ...pairs.map(([a, b]) => ({ address: periphery.zapIn!, abi: zapInAbi, functionName: 'routes', args: [tokens[a].address, tokens[b].address] })),
      ]
    : [];
  const outCalls: ContractCall[] = periphery?.zapOut && anchor
    ? [
        { address: periphery.zapOut, abi: zapOutAbi, functionName: 'isVaultRegistered', args: [vault.address] },
        ...outFrom.map((i) => ({ address: periphery.zapOut!, abi: zapOutAbi, functionName: 'routes', args: [tokens[i].address, anchor.address] })),
      ]
    : [];

  const inReads = useReads(inCalls, { chainId: vault.chainId, scope: vault.address, enabled: vault.hasDeployment && inCalls.length > 0 });
  const outReads = useReads(outCalls, { chainId: vault.chainId, scope: vault.address, enabled: vault.hasDeployment && outCalls.length > 0 });
  const inData = useLastGood(inCalls, inReads.data, vault.chainId, vault.address);
  const outData = useLastGood(outCalls, outReads.data, vault.chainId, vault.address);

  // `routes()` = (refPool, swapFee [pips], twapWindow, maxSlippageBps, maxDeviationBps); refPool 0 = no route.
  type RouteRead = readonly [Address, number, number, number, ...unknown[]];
  const routeAt = (data: ReadsData, i: number) => {
    const r = pick<RouteRead>(data, i);
    return r !== undefined && r[0] !== ZERO_ADDRESS ? r : undefined;
  };
  const registered = (data: ReadsData) => pick<boolean>(data, 0) === true;

  const candidates: ZapRoute[] = [];
  if (periphery?.zapIn && registered(inData)) {
    tokens.forEach((token, a) => {
      const legs = pairs.flatMap(([from], k) => (from === a ? [routeAt(inData, k + 1)] : []));
      if (legs.length === 0 || legs.some((r) => r === undefined)) return;
      candidates.push({ zap: periphery.zapIn!, token, index: a, maxLegSlippageBps: Math.max(0, ...legs.map((r) => Number(r![3]))) });
    });
    candidates.sort((x, y) => Number(y.index === usdg) - Number(x.index === usdg));
  }

  const outLegs = outFrom.map((_, k) => routeAt(outData, k + 1));
  const zapOut: ZapRoute | undefined =
    periphery?.zapOut && anchor && registered(outData) && outLegs.every((r) => r !== undefined)
      ? { zap: periphery.zapOut, token: anchor, index: usdg, maxLegSlippageBps: Math.max(0, ...outLegs.map((r) => Number(r![3]))) }
      : undefined;

  const status = (zap: Address | undefined, calls: readonly ContractCall[], data: ReadsData, isLoading: boolean, served: boolean): ZapStatus => {
    if (!vault.hasDeployment || !zap) return 'idle';
    if (served) return 'served';
    if (resolving) return 'probing';
    if (calls.length === 0) return 'idle';
    if (!data && isLoading) return 'probing';
    return 'not-served';
  };

  return {
    zapIn: candidates,
    zapOut,
    zapInStatus: status(periphery?.zapIn, inCalls, inData, inReads.isLoading, candidates.length > 0),
    zapOutStatus: status(periphery?.zapOut, outCalls, outData, outReads.isLoading, zapOut !== undefined),
  };
}

/** `allowance(owner → spender)` of one token on the vault's chain (the zap facets' approve step). */
export function useZapAllowance(vault: VaultTarget, token: Address | undefined, owner: Address | undefined, spender: Address | undefined) {
  const read = useReads(
    token && owner && spender ? [{ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] } as const] : [],
    { chainId: vault.chainId, scope: vault.address, enabled: vault.hasDeployment && Boolean(token && owner && spender) },
  );
  return { allowance: pick<bigint>(read.data, 0) ?? 0n, refetch: read.refetch };
}

/** `previewZap(vault, tokenIn, amountIn, slippageBps)` — reverts where `zapDeposit` would (pre-state). */
export function usePreviewZap(
  vault: VaultTarget,
  zap: Address | undefined,
  tokenIn: Address | undefined,
  amountIn: bigint,
  slippageBps: number,
  enabled: boolean,
) {
  const read = useReads(
    zap && tokenIn
      ? [{ address: zap, abi: zapInCallAbi, functionName: 'previewZap', args: [vault.address, tokenIn, amountIn, slippageBps] }]
      : [],
    { chainId: vault.chainId, scope: vault.address, enabled: vault.hasDeployment && enabled && amountIn > 0n, retry: false },
  );
  const data = pick<readonly [readonly Address[], readonly bigint[], bigint, readonly bigint[]]>(read.data, 0);
  return {
    tokens: data?.[0] ? [...data[0]] : undefined,
    /** Expected in-kind offer per registry token (route token kept + bought outputs). */
    offers: data?.[1] ? [...data[1]] : undefined,
    shares: data?.[2],
    refunds: data?.[3] ? [...data[3]] : undefined,
    error: read.error,
    isLoading: read.isFetching,
    refetch: read.refetch,
  };
}

/** Zap-out `previewRedeem(vault, tokenOut, shares, slippageBps)` — the exit facet's live quote. */
export function usePreviewZapRedeem(
  vault: VaultTarget,
  zap: Address | undefined,
  tokenOut: Address | undefined,
  shares: bigint,
  slippageBps: number,
  enabled: boolean,
) {
  const read = useReads(
    zap && tokenOut
      ? [{ address: zap, abi: zapOutCallAbi, functionName: 'previewRedeem', args: [vault.address, tokenOut, shares, slippageBps] }]
      : [],
    { chainId: vault.chainId, scope: vault.address, enabled: vault.hasDeployment && enabled && shares > 0n, retry: false },
  );
  const data = pick<readonly [readonly Address[], readonly bigint[], bigint, readonly bigint[]]>(read.data, 0);
  return {
    tokens: data?.[0] ? [...data[0]] : undefined,
    sold: data?.[1] ? [...data[1]] : undefined,
    amountOut: data?.[2],
    /** Delivered in kind (no route, or a dust sale), per registry token. */
    passThrough: data?.[3] ? [...data[3]] : undefined,
    error: read.error,
    isLoading: read.isFetching,
    refetch: read.refetch,
  };
}

/** `previewRedeem(shares)` for an arbitrary share amount (the redeem form's live breakdown). */
export function usePreviewRedeem(vault: VaultTarget, shares: bigint, enabled: boolean) {
  const read = useReads([{ ...vaultContract(vault), functionName: 'previewRedeem', args: [shares] }], {
    chainId: vault.chainId,
    scope: vault.address,
    enabled: vault.hasDeployment && enabled && shares > 0n,
    retry: false,
  });
  const data = pick<readonly [readonly Address[], readonly bigint[]]>(read.data, 0);
  return {
    owed: data?.[1] ? [...data[1]] : undefined,
    error: read.error,
    isLoading: read.isFetching,
  };
}
