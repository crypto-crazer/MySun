/**
 * Live reads of the deployed MySun vault.
 *
 * Every read targets the TARGET chain and the SELECTED vault on it (src/chain/targetChain.ts), so the
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
import { useMemo } from 'react';
import type { Address } from 'viem';
import { erc20Abi } from 'viem';
import { vaultAbi, positionAdapterAbi, mockAdapterAbi, zapInAbi, zapOutAbi } from '@/config/generated';
import type { ChainDeployment, VaultEntry } from './chains';
import { pick, useReads } from './useReads';
import { useTargetChain } from './useTargetChain';
import { ZAP_ROUTE_SYMBOL, zapInCallAbi, zapOutCallAbi } from './zap';

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
  symbol: string;
  name: string;
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
  /** The registry entry of the selected vault (key, label, configured receipt); undefined without a deployment. */
  entry: VaultEntry | undefined;
  hasDeployment: boolean;
  /** `name()` / `symbol()` as read from the chain; undefined until the read lands. */
  name?: string;
  symbol?: string;
  /** The receipt token to display: the chain's name/symbol, else the registry's, else "sunEthLP". */
  receipt: { name: string; symbol: string };
  decimals: number;
  tokens: TokenMeta[];
  /** Per token: idle + everything the adapters hold, aligned to `tokens`. */
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

/** Vault-wide state on the target chain. Safe to call without a wallet. */
export function useLiveVault(): LiveVault {
  const { chain, deployment, vault: entry } = useTargetChain();
  const chainId = chain.id;
  const hasDeployment = deployment !== undefined && entry !== undefined;
  const address = (entry?.vault ?? ZERO_ADDRESS) as Address;
  const vault = vaultContract({ address });

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

  const tokenAddresses = pick<readonly Address[]>(basics.data, 0) ?? [];
  const totalsRaw = pick<readonly [readonly Address[], readonly bigint[]]>(basics.data, 1);
  const adapterAddresses = pick<readonly Address[]>(basics.data, 5) ?? [];

  // Per-token metadata + the vault's own (idle) balance.
  const tokenReads = useReads(
    tokenAddresses.flatMap((t) => [
      { address: t, abi: erc20Abi, functionName: 'symbol' } as const,
      { address: t, abi: erc20Abi, functionName: 'decimals' } as const,
      { address: t, abi: erc20Abi, functionName: 'name' } as const,
      { address: t, abi: erc20Abi, functionName: 'balanceOf', args: [address] } as const,
    ]),
    { chainId, scope: address, enabled: hasDeployment && tokenAddresses.length > 0 },
  );

  const tokens: TokenMeta[] = useMemo(
    () =>
      tokenAddresses.map((address, i) => ({
        address,
        symbol: pick<string>(tokenReads.data, i * 4) ?? '???',
        decimals: Number(pick<number>(tokenReads.data, i * 4 + 1) ?? 18),
        name: pick<string>(tokenReads.data, i * 4 + 2) ?? '',
      })),
    [tokenAddresses.join(','), tokenReads.data],
  );

  const idle = useMemo(
    () => tokenAddresses.map((_, i) => pick<bigint>(tokenReads.data, i * 4 + 3) ?? 0n),
    [tokenAddresses.join(','), tokenReads.data],
  );

  const totals = useMemo(() => {
    if (!totalsRaw) return tokenAddresses.map(() => 0n);
    const [, amounts] = totalsRaw;
    return tokenAddresses.map((_, i) => amounts[i] ?? 0n);
  }, [totalsRaw, tokenAddresses.join(',')]);

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
    decimals: Number(pick<number>(basics.data, 8) ?? 18),
    tokens,
    totals,
    idle,
    inPosition: totals.map((t, i) => {
      const rest = t - (idle[i] ?? 0n);
      return rest > 0n ? rest : 0n;
    }),
    totalSupply: pick<bigint>(basics.data, 2) ?? 0n,
    performanceFeeBps: Number(pick<number>(basics.data, 3) ?? 0),
    paused: pick<boolean>(basics.data, 4) ?? false,
    owner: pick<Address>(basics.data, 9),
    treasury: pick<Address>(basics.data, 10),
    adapters: adapters.reports,
    isLoading: basics.isLoading || tokenReads.isLoading,
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

/** A zap facet the selected vault can offer: the periphery contract and the single token it routes. */
export interface ZapRoute {
  zap: Address;
  /** The route token (USDG): what a zap-in takes and a zap-out pays. */
  token: TokenMeta;
  /** Its index in the vault registry. */
  index: number;
}

/**
 * Which zap facets the selected vault has. A facet exists only when the CHAIN lists the periphery
 * contract (planned chains list none), the basket holds the route token, the zap has this vault
 * registered, and every other basket token has a route (from the route token for a
 * zap-in, into it for a zap-out) — otherwise "USDG only" would not be what the contract does.
 */
export function useZapRoutes(vault: LiveVault): { zapIn?: ZapRoute; zapOut?: ZapRoute } {
  const periphery = vault.deployment?.periphery;
  const index = vault.tokens.findIndex((t) => t.symbol === ZAP_ROUTE_SYMBOL);
  const token = index === -1 ? undefined : vault.tokens[index];
  // Every other basket token, not only those with a non-zero total: stable before the totals land.
  const others = token ? vault.tokens.filter((_, i) => i !== index) : [];

  const probe = (zap: Address | undefined, abi: typeof zapInAbi | typeof zapOutAbi, into: boolean) =>
    zap && token
      ? [
          { address: zap, abi, functionName: 'isVaultRegistered', args: [vault.address] } as const,
          ...others.map((o) => ({
            address: zap,
            abi,
            functionName: 'routes',
            args: into ? [o.address, token.address] : [token.address, o.address],
          }) as const),
        ]
      : [];

  const inReads = useReads(probe(periphery?.zapIn, zapInAbi, false), {
    chainId: vault.chainId,
    scope: vault.address,
    enabled: vault.hasDeployment && Boolean(periphery?.zapIn && token),
  });
  const outReads = useReads(probe(periphery?.zapOut, zapOutAbi, true), {
    chainId: vault.chainId,
    scope: vault.address,
    enabled: vault.hasDeployment && Boolean(periphery?.zapOut && token),
  });

  const available = (data: ReturnType<typeof useReads>['data']) =>
    pick<boolean>(data, 0) === true &&
    others.every((_, i) => {
      const route = pick<readonly [Address, ...unknown[]]>(data, i + 1);
      return route !== undefined && route[0] !== ZERO_ADDRESS;
    });

  return {
    zapIn: periphery?.zapIn && token && available(inReads.data) ? { zap: periphery.zapIn, token, index } : undefined,
    zapOut: periphery?.zapOut && token && available(outReads.data) ? { zap: periphery.zapOut, token, index } : undefined,
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
