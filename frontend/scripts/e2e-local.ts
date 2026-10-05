/**
 * e2e:local — exercise the deployed vaults end to end with viem, straight against the local Anvil
 * node. No React, no UI framework: this is the ground truth the UI is checked against.
 *
 * The local stack runs several vaults (registry v2, shared/deployment.local.json → `vaults`):
 *
 *   1–6  the DEFAULT vault — resolved with the app's own rule (src/chain/vaultSelection.ts):
 *        read vault → mint → approve → previewDeposit → deposit → previewRedeem → redeem half
 *        On the RHC fork stack (deployment.local.json `mintable: false`) the default vault's tokens
 *        are REAL (USDG / WETH) and its adapters are the real Uniswap v3 / v4 ones: nothing can be
 *        minted, so step 2 instead asserts account #2 was funded at deploy time (fork-demo-up.sh);
 *        every other step and assertion is identical.
 *   7    every vault: name()/symbol() agree with the registry receipt, totalTokens() reads
 *   7b   (fork only) the "Fund my wallet" faucet: the real basket classifies transfer-only, the
 *        stocks six classify as mints, and every token lands via an impersonated pool send — no
 *        wallet prompt on either path (src/chain/faucet.ts)
 *   7c   the ETH top-up: a zero-ETH address is raised to exactly 1 ETH through anvil_setBalance, an
 *        account already above the floor is left untouched, a second call is a no-op
 *   8    the `stocks` vault: mint its six basket tokens → approve → deposit all six in strict
 *        proportion → redeem part — and its receipt token is the registry's own symbol, isolated from the default
 *   9    (stacks with zap periphery) the single-asset facets on the default vault, the app's own math
 *        (src/chain/zap.ts): 9a zap deposit USDG only — minted ≈ previewZap, the offer consumed with
 *        only dust refunded, the user→zap allowance spent to 0, both Permit2 layers and every zap
 *        balance zeroed; 9b zap exit to USDG only — USDG ≥ the previewed minimum, shares burned, no
 *        pass-through, zap dust zero
 *
 * Every step asserts that the chain moved exactly as the contract promises (shares minted equal the
 * preview, only the REQUIRED amount is pulled even though more was offered, redeem returns the
 * previewed basket, totals and supply move by the same deltas).
 *
 * LOCAL ONLY. The key below is Anvil dev account #2 — a publicly known test key with no value on any
 * real network. The script refuses to run against anything that is not a loopback / private-network
 * RPC answering the expected chain id.
 */
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { vaultAbi, mockTokenAbi, positionAdapterAbi, zapInAbi, zapOutAbi } from '../src/config/generated';
import { dexLabel, poolIdLabel, toExactString } from '../src/chain/amounts';
import {
  ZAP_DEFAULT_SLIPPAGE_BPS,
  ZAP_ROUTE_SYMBOL,
  parseZapDepositAmount,
  parseZapRedeemShares,
  zapInCallAbi,
  zapMinimum,
  zapOutCallAbi,
  zapSizeWarning,
} from '../src/chain/zap';
import { faucetAmount, faucetKind, fundEth, impersonatedFund } from '../src/chain/faucet';
import { canMintMocks, chainFor, deploymentForChain, findVault, isForkDeployment, type ChainDeployment, type VaultEntry } from '../src/chain/chains';
import { resolveVault } from '../src/chain/vaultSelection';

/** The local demo stack's chain id (Anvil runs with the RHC testnet id). */
const LOCAL_CHAIN_ID = 46630;

/** The registry's local entry — the one overlaid from shared/deployment.local.json. */
function localDeployment(): ChainDeployment {
  const d = deploymentForChain(LOCAL_CHAIN_ID);
  if (!d?.local) throw new Error(`no local deployment for chain ${LOCAL_CHAIN_ID} — run pnpm sync:shared after DemoLocal.s.sol`);
  return d;
}
const LOCAL_DEPLOYMENT = localDeployment();

/** Anvil dev account #2 — public, well-known, LOCAL ONLY. Never fund this on a real network. */
const ANVIL_ACCOUNT_2_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex;
const EXPECTED_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

/** The vault the app shows first on the local chain: no stored choice → the first listed. */
const DEFAULT_VAULT: VaultEntry = (() => {
  const v = resolveVault(LOCAL_CHAIN_ID, {});
  if (!v) throw new Error(`no vaults for chain ${LOCAL_CHAIN_ID}`);
  return v;
})();
/** The second basket on the local stack (5 stocks + mUSDG). */
const STOCKS_VAULT: VaultEntry = (() => {
  const v = findVault(LOCAL_CHAIN_ID, 'stocks');
  if (!v) throw new Error(`no "stocks" vault on chain ${LOCAL_CHAIN_ID} — is shared/deployment.local.json from the two-vault DemoLocal.s.sol?`);
  return v;
})();

/** False on the RHC fork stack: the default vault's tokens are real, `MockToken.mint` does not exist. */
const MINTABLE = canMintMocks(LOCAL_DEPLOYMENT);
const FORK = isForkDeployment(LOCAL_DEPLOYMENT);

const RPC = LOCAL_DEPLOYMENT.rpcUrl;
const VAULT = DEFAULT_VAULT.vault as Address;
const SLIPPAGE_BPS = 50n; // 0.50%, the UI default

/** Loopback, or an RFC 1918 private address (the dev chain may be served on the LAN IP). */
function isLocalHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
if (!isLocalHost(new URL(RPC).hostname)) {
  throw new Error(`refusing to run: ${RPC} is not a local/private RPC (this script uses a public test key)`);
}

// The same registry-built chain the app uses (rpc from deployment.local.json).
const chain = chainFor(LOCAL_CHAIN_ID)!;

const account = privateKeyToAccount(ANVIL_ACCOUNT_2_KEY);
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });

/* ------------------------------------- tiny test harness ------------------------------------- */

let checks = 0;
function assert(condition: boolean, label: string, detail?: string): void {
  checks++;
  if (!condition) {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    throw new Error(`assertion failed: ${label}`);
  }
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
}

/** Adaptive precision, same rule as the UI: small receipt-token slices stay readable. */
function fmt(value: bigint, decimals: number, sig = 6): string {
  const base = 10n ** BigInt(decimals);
  const int = (value / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let digits = sig;
  if (value > 0n && value < base) {
    let probe = value * 10n;
    while (probe < base && digits < decimals) {
      digits++;
      probe *= 10n;
    }
  }
  const frac = (value % base).toString().padStart(decimals, '0').slice(0, digits).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 62 - title.length))}`);
}

async function send(hash: Hex, label: string): Promise<Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label} reverted (${hash})`);
  return receipt;
}

/* ----------------------------------------- the run ------------------------------------------- */

async function main(): Promise<void> {
  console.log('MySun frontend e2e — local Anvil');
  console.log(`rpc ${RPC} · chain ${LOCAL_DEPLOYMENT.chainId} · ${LOCAL_DEPLOYMENT.vaults.length} vaults`);
  console.log(`stack: ${FORK ? 'RHC FORK (real tokens + real Uniswap adapters on the default vault)' : 'all-mock'} · mintable ${MINTABLE}`);
  for (const v of LOCAL_DEPLOYMENT.vaults) {
    console.log(`  ${v.key === DEFAULT_VAULT.key ? '*' : ' '} ${v.key.padEnd(8)} ${v.vault} · ${v.receipt.symbol} · ${v.label}`);
  }
  console.log(`  (* = default vault, what the app shows with no stored choice)`);
  console.log(`account #2 ${account.address}`);

  assert(account.address.toLowerCase() === EXPECTED_ADDRESS.toLowerCase(), 'signer is Anvil account #2');
  const liveChainId = await publicClient.getChainId();
  assert(liveChainId === LOCAL_DEPLOYMENT.chainId, 'chain id matches shared/deployment.local.json', String(liveChainId));

  /* ------------------------------------- 1. read the vault ------------------------------------ */
  section(`1. read the default vault (${DEFAULT_VAULT.key})`);

  const vault = { address: VAULT, abi: vaultAbi } as const;
  const [name, symbol, decimals, tokens, totalsBefore, supplyBefore, feeBps, paused, adapters] = await Promise.all([
    publicClient.readContract({ ...vault, functionName: 'name' }) as Promise<string>,
    publicClient.readContract({ ...vault, functionName: 'symbol' }) as Promise<string>,
    publicClient.readContract({ ...vault, functionName: 'decimals' }) as Promise<number>,
    publicClient.readContract({ ...vault, functionName: 'tokens' }) as Promise<readonly Address[]>,
    publicClient.readContract({ ...vault, functionName: 'totalTokens' }) as Promise<readonly [readonly Address[], readonly bigint[]]>,
    publicClient.readContract({ ...vault, functionName: 'totalSupply' }) as Promise<bigint>,
    publicClient.readContract({ ...vault, functionName: 'performanceFeeBps' }) as Promise<number>,
    publicClient.readContract({ ...vault, functionName: 'paused' }) as Promise<boolean>,
    publicClient.readContract({ ...vault, functionName: 'adapters' }) as Promise<readonly Address[]>,
  ]);

  console.log(`  ${name} (${symbol}), ${decimals} decimals · fee ${feeBps / 100}% · paused ${paused}`);
  assert(name === DEFAULT_VAULT.receipt.name && symbol === DEFAULT_VAULT.receipt.symbol, 'receipt name/symbol match the registry entry', symbol);
  assert(tokens.length > 0, 'vault has basket tokens', `${tokens.length} tokens`);
  assert(!paused, 'deposits are not paused');

  const meta = await Promise.all(
    tokens.map(async (address) => ({
      address,
      symbol: (await publicClient.readContract({ address, abi: mockTokenAbi, functionName: 'symbol' })) as string,
      decimals: Number(await publicClient.readContract({ address, abi: mockTokenAbi, functionName: 'decimals' })),
    })),
  );
  for (const [i, t] of meta.entries()) {
    console.log(`  token ${i}: ${t.symbol} (${t.decimals} dp) ${t.address} · total ${fmt(totalsBefore[1][i], t.decimals)}`);
  }
  if (FORK) {
    // The fork stack is a frozen snapshot of RHC state (contracts/script/fork-demo-freeze.mjs): a slot the
    // live fork never read comes back as zero. Real USDG / WETH metadata surviving the freeze is the canary.
    assert(
      meta.every((t) => t.decimals > 0 && t.symbol.length > 0),
      'fork: every real basket token kept its symbol / decimals through the freeze',
      meta.map((t) => `${t.symbol} ${t.decimals} dp`).join(', '),
    );
  }
  console.log(`  ${symbol} supply ${fmt(supplyBefore, decimals)} (${supplyBefore} base units)`);

  for (const a of adapters) {
    const [dex, poolId, position] = await Promise.all([
      publicClient.readContract({ address: a, abi: positionAdapterAbi, functionName: 'dex' }) as Promise<Hex>,
      publicClient.readContract({ address: a, abi: positionAdapterAbi, functionName: 'poolId' }) as Promise<Hex>,
      publicClient.readContract({ address: a, abi: positionAdapterAbi, functionName: 'position' }) as Promise<
        readonly [readonly Address[], readonly bigint[]]
      >,
    ]);
    console.log(
      // position() is in the ADAPTER's token order (pool order on the real adapters), not the vault's.
      `  adapter ${a} · ${dexLabel(dex)} · ${poolIdLabel(poolId)} · position ${position[1]
        .map((v, i) => {
          const t = meta.find((m) => m.address.toLowerCase() === position[0][i]?.toLowerCase());
          return `${fmt(v, t?.decimals ?? 18)} ${t?.symbol ?? '?'}`;
        })
        .join(' + ')}`,
    );
  }
  assert(adapters.length > 0, 'adapters are registered', `${adapters.length}`);

  const balanceOf = async (token: Address, who: Address) =>
    (await publicClient.readContract({ address: token, abi: mockTokenAbi, functionName: 'balanceOf', args: [who] })) as bigint;

  // Deliberately lopsided: plenty of token 0, far more of token 1 than the ratio needs.
  const offered = meta.map((t, i) => (i === 0 ? 10_000n : 10n) * 10n ** BigInt(t.decimals));

  if (MINTABLE) {
    /* ---------------------------------- 2. mint test tokens ---------------------------------- */
    section('2. mint mock tokens to account #2');

    const mintAmounts = meta.map((t) => 50_000n * 10n ** BigInt(t.decimals));
    for (const [i, t] of meta.entries()) {
      const before = await balanceOf(t.address, account.address);
      const hash = await walletClient.writeContract({
        address: t.address,
        abi: mockTokenAbi,
        functionName: 'mint',
        args: [account.address, mintAmounts[i]],
      });
      await send(hash, `mint ${t.symbol}`);
      const after = await balanceOf(t.address, account.address);
      assert(after - before === mintAmounts[i], `minted ${fmt(mintAmounts[i], t.decimals)} ${t.symbol}`, `balance ${fmt(after, t.decimals)}`);
    }
  } else {
    /* ------------------- 2. real tokens: the wallet was funded at deploy time ------------------- */
    section('2. real tokens (fork, mintable: false) — account #2 was funded at deploy time');

    for (const [i, t] of meta.entries()) {
      const balance = await balanceOf(t.address, account.address);
      assert(
        balance >= offered[i],
        `account #2 holds enough real ${t.symbol} for the full offer (no mint on this stack)`,
        `balance ${fmt(balance, t.decimals)} ≥ offer ${fmt(offered[i], t.decimals)}`,
      );
    }
  }

  /* --------------------------------- 3. previewDeposit + approve ------------------------------ */
  section('3. previewDeposit (offers are maximums)');

  console.log(`  offering ${offered.map((v, i) => `${fmt(v, meta[i].decimals)} ${meta[i].symbol}`).join(' + ')}`);

  const [previewShares, required] = (await publicClient.readContract({
    ...vault,
    functionName: 'previewDeposit',
    args: [tokens, offered],
  })) as readonly [bigint, readonly bigint[]];

  console.log(`  preview: ${fmt(previewShares, decimals)} ${symbol} (${previewShares} base units)`);
  console.log(`  required: ${required.map((v, i) => `${fmt(v, meta[i].decimals)} ${meta[i].symbol}`).join(' + ')}`);
  assert(previewShares > 0n, 'previewDeposit returns a positive share count');
  assert(
    required.every((v, i) => v <= offered[i]),
    'required ≤ offered for every token (excess is never pulled)',
  );
  assert(
    required.some((v, i) => v < offered[i]),
    'at least one token is pulled below the offer — the binding ratio, not the offer, sets the pull',
  );

  section('4. approve the vault');
  for (const [i, t] of meta.entries()) {
    const hash = await walletClient.writeContract({
      address: t.address,
      abi: mockTokenAbi,
      functionName: 'approve',
      args: [VAULT, offered[i]],
    });
    await send(hash, `approve ${t.symbol}`);
    const allowance = (await publicClient.readContract({
      address: t.address,
      abi: mockTokenAbi,
      functionName: 'allowance',
      args: [account.address, VAULT],
    })) as bigint;
    assert(allowance >= required[i], `${t.symbol} allowance covers the required pull`, fmt(allowance, t.decimals));
  }

  /* -------------------------------------- 5. deposit ------------------------------------------ */
  section('5. deposit');

  const minShares = (previewShares * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  assert(minShares > 0n, 'minShares is non-zero (the contract rejects 0)', fmt(minShares, decimals));

  const walletBefore = await Promise.all(meta.map((t) => balanceOf(t.address, account.address)));
  const sharesBefore = (await publicClient.readContract({ ...vault, functionName: 'balanceOf', args: [account.address] })) as bigint;

  const { result: simulatedShares, request } = await publicClient.simulateContract({
    ...vault,
    functionName: 'deposit',
    args: [tokens, offered, minShares, account.address],
    account,
  });
  assert(simulatedShares === previewShares, 'simulated deposit mints exactly the previewed shares', fmt(simulatedShares, decimals));

  const depositReceipt = await send(await walletClient.writeContract(request), 'deposit');
  const deposited = parseEventLogs({ abi: vaultAbi, logs: depositReceipt.logs, eventName: 'Deposited' })[0];
  const mintedShares = (deposited.args as { shares: bigint }).shares;
  const pulled = (deposited.args as { amounts: readonly bigint[] }).amounts;

  const sharesAfter = (await publicClient.readContract({ ...vault, functionName: 'balanceOf', args: [account.address] })) as bigint;
  const walletAfter = await Promise.all(meta.map((t) => balanceOf(t.address, account.address)));

  assert(mintedShares === previewShares, 'Deposited event shares == previewDeposit', fmt(mintedShares, decimals));
  assert(sharesAfter - sharesBefore === previewShares, `${symbol} balance grew by exactly the minted shares`);
  assert(
    pulled.every((v, i) => v === required[i]),
    'Deposited event amounts == previewDeposit requiredAmounts',
  );
  for (const [i, t] of meta.entries()) {
    assert(
      walletBefore[i] - walletAfter[i] === required[i],
      `${t.symbol} wallet balance fell by exactly the required amount`,
      fmt(required[i], t.decimals),
    );
  }

  const totalsAfterDeposit = (await publicClient.readContract({ ...vault, functionName: 'totalTokens' })) as readonly [
    readonly Address[],
    readonly bigint[],
  ];
  for (const [i, t] of meta.entries()) {
    assert(
      totalsAfterDeposit[1][i] - totalsBefore[1][i] === required[i],
      `vault total ${t.symbol} grew by the pulled amount`,
      fmt(totalsAfterDeposit[1][i], t.decimals),
    );
  }
  const supplyAfterDeposit = (await publicClient.readContract({ ...vault, functionName: 'totalSupply' })) as bigint;
  assert(supplyAfterDeposit - supplyBefore === previewShares, `${symbol} supply grew by the minted shares`);

  /* --------------------------------- 6. previewRedeem + redeem -------------------------------- */
  section('6. previewRedeem + redeem half');

  const half = sharesAfter / 2n;
  const [, owed] = (await publicClient.readContract({ ...vault, functionName: 'previewRedeem', args: [half] })) as readonly [
    readonly Address[],
    readonly bigint[],
  ];
  console.log(`  redeeming ${fmt(half, decimals)} ${symbol}`);
  console.log(`  previewRedeem: ${owed.map((v, i) => `${fmt(v, meta[i].decimals)} ${meta[i].symbol}`).join(' + ')}`);
  assert(
    owed.some((v) => v > 0n),
    'previewRedeem returns a non-empty basket',
  );

  const preRedeemWallet = await Promise.all(meta.map((t) => balanceOf(t.address, account.address)));
  const redeemReceipt = await send(
    await walletClient.writeContract({ ...vault, functionName: 'redeem', args: [half, account.address] }),
    'redeem',
  );
  const redeemed = parseEventLogs({ abi: vaultAbi, logs: redeemReceipt.logs, eventName: 'Redeemed' })[0];
  const delivered = (redeemed.args as { amounts: readonly bigint[] }).amounts;

  const postRedeemWallet = await Promise.all(meta.map((t) => balanceOf(t.address, account.address)));
  const sharesFinal = (await publicClient.readContract({ ...vault, functionName: 'balanceOf', args: [account.address] })) as bigint;
  const supplyFinal = (await publicClient.readContract({ ...vault, functionName: 'totalSupply' })) as bigint;
  const totalsFinal = (await publicClient.readContract({ ...vault, functionName: 'totalTokens' })) as readonly [
    readonly Address[],
    readonly bigint[],
  ];

  // Real Uniswap v3/v4 adapters (the fork stack's default vault) are exact only up to rounding:
  //  - `redeem` burns floor(L·bps/1e4) LIQUIDITY while previewRedeem takes floor(bps) of the position()
  //    AMOUNTS, so the delivery can fall short of the preview by ~one liquidity unit's worth per adapter
  //    (a few hundred wei of WETH at this range) — never above the preview;
  //  - the vault total is re-read through position() (floor roundings), so its drop can differ from the
  //    delivery by a base unit or two per adapter.
  // Bound for both: 1 ppb of the amount + 2 base units per adapter; the exact gaps are printed.
  // See contracts/REPORT-FORK-DEMO.md §2. The mock stack keeps exact equality everywhere.
  const slack = (amount: bigint) => (FORK ? amount / 1_000_000_000n + 2n * BigInt(adapters.length) : 0n);
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const totalsDrop = meta.map((_, i) => totalsAfterDeposit[1][i] - totalsFinal[1][i]);
  if (FORK) {
    console.log(`  preview − delivered (base units): ${owed.map((v, i) => `${v - delivered[i]} ${meta[i].symbol}`).join(', ')}`);
    console.log(`  total drop − delivered (base units): ${totalsDrop.map((v, i) => `${v - delivered[i]} ${meta[i].symbol}`).join(', ')}`);
    assert(
      delivered.every((v, i) => v <= owed[i]),
      'Redeemed event amounts ≤ previewRedeem for every token (real adapters: never more than previewed)',
    );
  }
  assert(
    FORK ? delivered.every((v, i) => owed[i] - v <= slack(owed[i])) : delivered.every((v, i) => v === owed[i]),
    FORK
      ? 'Redeemed event amounts == previewRedeem within liquidity rounding (1 ppb + 2 units/adapter)'
      : 'Redeemed event amounts == previewRedeem',
  );
  for (const [i, t] of meta.entries()) {
    assert(
      postRedeemWallet[i] - preRedeemWallet[i] === delivered[i],
      `${t.symbol} arrived in the wallet in kind — exactly the Redeemed amount`,
      fmt(delivered[i], t.decimals),
    );
    assert(
      FORK ? abs(totalsDrop[i] - delivered[i]) <= slack(delivered[i]) : totalsDrop[i] === delivered[i],
      FORK
        ? `vault total ${t.symbol} fell by what was delivered (within position() rounding)`
        : `vault total ${t.symbol} fell by exactly what was delivered`,
      fmt(totalsFinal[1][i], t.decimals),
    );
  }
  assert(sharesAfter - sharesFinal === half, `${symbol} balance fell by the redeemed shares`, fmt(sharesFinal, decimals));
  assert(supplyAfterDeposit - supplyFinal === half, `${symbol} supply fell by the redeemed shares`, fmt(supplyFinal, decimals));
  assert(sharesFinal > 0n, 'half the position is still held after redeeming half');

  await everyVault();
  await faucetCheck(meta);
  await ethTopUpCheck();
  await stocksRoundTrip();
  await zapRoundTrip();

  section('done');
  console.log(`${checks} assertions passed.`);
}

/* ------------------------------------- 7. every vault ------------------------------------------ */

async function everyVault(): Promise<void> {
  section('7. every vault on the chain — receipt + totals');
  const seen = new Set<string>();
  for (const v of LOCAL_DEPLOYMENT.vaults) {
    const target = { address: v.vault as Address, abi: vaultAbi } as const;
    const [name, symbol, totals] = await Promise.all([
      publicClient.readContract({ ...target, functionName: 'name' }) as Promise<string>,
      publicClient.readContract({ ...target, functionName: 'symbol' }) as Promise<string>,
      publicClient.readContract({ ...target, functionName: 'totalTokens' }) as Promise<readonly [readonly Address[], readonly bigint[]]>,
    ]);
    const symbols = await Promise.all(
      totals[0].map((t) => publicClient.readContract({ address: t, abi: mockTokenAbi, functionName: 'symbol' }) as Promise<string>),
    );
    console.log(`  ${v.key}: ${name} (${symbol}) · ${totals[0].length} tokens · ${symbols.join(', ')}`);
    assert(name === v.receipt.name, `${v.key}: name() == registry receipt.name`, name);
    assert(symbol === v.receipt.symbol, `${v.key}: symbol() == registry receipt.symbol`, symbol);
    assert(totals[0].length > 0 && totals[0].length === totals[1].length, `${v.key}: totalTokens() lists a basket`, `${totals[0].length} tokens`);
    seen.add(symbol);
  }
  assert(seen.size === LOCAL_DEPLOYMENT.vaults.length, 'every vault has its own receipt symbol', [...seen].join(', '));
}

/* ----------------------------- 7b. fork faucet (Fund my wallet) ------------------------------- */

async function faucetCheck(meta: readonly { address: Address; symbol: string; decimals: number }[]): Promise<void> {
  if (!FORK) return; // mock stacks mint their own tokens; step 2 already covers their balances
  section('7b. fork faucet — "Fund my wallet": impersonated pool sends, no wallet prompt (local node only)');
  const balanceOf = async (token: Address) =>
    (await publicClient.readContract({ address: token, abi: mockTokenAbi, functionName: 'balanceOf', args: [account.address] })) as bigint;
  const deliver = async (t: { address: Address; symbol: string; decimals: number }, expected: 'mint' | 'transfer') => {
    const amount = faucetAmount(t.decimals);
    const kind = await faucetKind(LOCAL_DEPLOYMENT.chainId, t.address, account.address, amount);
    assert(kind === expected, `${t.symbol}: the faucet classifies as ${expected}`, kind);
    const before = await balanceOf(t.address);
    const hash = await impersonatedFund(LOCAL_DEPLOYMENT.chainId, kind, t.address, account.address, amount);
    const after = await balanceOf(t.address);
    assert(after - before === amount, `the faucet delivered ${fmt(amount, t.decimals)} ${t.symbol} (impersonated pool ${expected})`, `tx ${hash.slice(0, 10)}…`);
  };
  for (const t of meta) await deliver(t, 'transfer'); // the default basket: real tokens
  // The stocks basket is mock tokens: the faucet mints them from the pool too — still zero prompts.
  const stocksTokens = (await publicClient.readContract({ address: STOCKS_VAULT.vault as Address, abi: vaultAbi, functionName: 'tokens' })) as readonly Address[];
  for (const token of stocksTokens) {
    const [symbol, decimals] = await Promise.all([
      publicClient.readContract({ address: token, abi: mockTokenAbi, functionName: 'symbol' }) as Promise<string>,
      publicClient.readContract({ address: token, abi: mockTokenAbi, functionName: 'decimals' }) as Promise<number>,
    ]);
    await deliver({ address: token, symbol, decimals: Number(decimals) }, 'mint');
  }
}

/* -------------------------------- 7c. ETH top-up (any wallet) --------------------------------- */

async function ethTopUpCheck(): Promise<void> {
  section('7c. ETH top-up — any wallet is raised to 1 ETH, funded accounts are left untouched');
  const fresh = '0x000000000000000000000000000000000000bEEF' as Address;
  // Rerunnable: start the probe address from zero (local node only, like everything here).
  await publicClient.request({ method: 'anvil_setBalance', params: [fresh, '0x0'] } as never);
  const before = await publicClient.getBalance({ address: fresh });
  const topped = await fundEth(LOCAL_DEPLOYMENT.chainId, fresh);
  assert(before === 0n && topped === 10n ** 18n, 'a fresh address is topped up to exactly 1 ETH', `${fmt(before, 18)} → ${fmt(topped, 18)}`);
  const readBack = await publicClient.getBalance({ address: fresh });
  assert(readBack === 10n ** 18n, 'the node really holds the topped-up balance (anvil_setBalance applied)', fmt(readBack, 18));
  const again = await fundEth(LOCAL_DEPLOYMENT.chainId, fresh);
  assert(again === 10n ** 18n, 'a second top-up is a no-op (already at the floor)');

  const fundedBefore = await publicClient.getBalance({ address: account.address });
  const kept = await fundEth(LOCAL_DEPLOYMENT.chainId, account.address);
  assert(fundedBefore > 10n ** 18n && kept === fundedBefore, 'account #2 (~10k ETH, funded at deploy time) is never lowered', fmt(kept, 18));
}

/* --------------------------------- 8. stocks vault round trip -------------------------------- */

async function stocksRoundTrip(): Promise<void> {
  const target = { address: STOCKS_VAULT.vault as Address, abi: vaultAbi } as const;
  const defaultTarget = { address: VAULT, abi: vaultAbi } as const;
  const balanceOf = async (token: Address) =>
    (await publicClient.readContract({ address: token, abi: mockTokenAbi, functionName: 'balanceOf', args: [account.address] })) as bigint;
  const sharesOf = async (vault: { address: Address; abi: typeof vaultAbi }) =>
    (await publicClient.readContract({ ...vault, functionName: 'balanceOf', args: [account.address] })) as bigint;

  section(`8. ${STOCKS_VAULT.key} vault — deposit all six in strict proportion, redeem part`);
  const [symbol, decimals, tokens, totalsBefore, supplyBefore, paused] = await Promise.all([
    publicClient.readContract({ ...target, functionName: 'symbol' }) as Promise<string>,
    publicClient.readContract({ ...target, functionName: 'decimals' }) as Promise<number>,
    publicClient.readContract({ ...target, functionName: 'tokens' }) as Promise<readonly Address[]>,
    publicClient.readContract({ ...target, functionName: 'totalTokens' }) as Promise<readonly [readonly Address[], readonly bigint[]]>,
    publicClient.readContract({ ...target, functionName: 'totalSupply' }) as Promise<bigint>,
    publicClient.readContract({ ...target, functionName: 'paused' }) as Promise<boolean>,
  ]);
  assert(tokens.length === 6, 'stocks basket has six tokens', String(tokens.length));
  assert(!paused, 'stocks deposits are not paused');
  assert(supplyBefore > 0n, 'stocks vault is past genesis (proportional deposits need a basket to match)', fmt(supplyBefore, decimals));
  const meta = await Promise.all(
    tokens.map(async (address) => ({
      address,
      symbol: (await publicClient.readContract({ address, abi: mockTokenAbi, functionName: 'symbol' })) as string,
      decimals: Number(await publicClient.readContract({ address, abi: mockTokenAbi, functionName: 'decimals' })),
    })),
  );
  if (FORK) {
    const kind = await faucetKind(LOCAL_DEPLOYMENT.chainId, meta[0].address, account.address, faucetAmount(meta[0].decimals));
    assert(kind === 'mint', 'stocks tokens take the mint path in the faucet (MockToken.mint)', `${meta[0].symbol}: ${kind}`);
  }
  console.log(`  basket: ${meta.map((t, i) => `${fmt(totalsBefore[1][i], t.decimals)} ${t.symbol}`).join(' + ')}`);

  // Strict proportion: 10% of the vault's current total of EVERY token.
  const offered = totalsBefore[1].map((t) => t / 10n);
  assert(offered.every((v) => v > 0n), 'every offered amount is non-zero');

  for (const [i, t] of meta.entries()) {
    const before = await balanceOf(t.address);
    await send(
      await walletClient.writeContract({ address: t.address, abi: mockTokenAbi, functionName: 'mint', args: [account.address, offered[i]] }),
      `mint ${t.symbol}`,
    );
    assert((await balanceOf(t.address)) - before === offered[i], `minted ${fmt(offered[i], t.decimals)} ${t.symbol} (MockToken.mint is public)`);
  }
  for (const [i, t] of meta.entries()) {
    await send(
      await walletClient.writeContract({ address: t.address, abi: mockTokenAbi, functionName: 'approve', args: [target.address, offered[i]] }),
      `approve ${t.symbol}`,
    );
  }
  const allowances = await Promise.all(
    meta.map((t) => publicClient.readContract({ address: t.address, abi: mockTokenAbi, functionName: 'allowance', args: [account.address, target.address] }) as Promise<bigint>),
  );
  assert(allowances.every((a, i) => a === offered[i]), 'all six approved to the stocks vault for exactly the offer');

  const [previewShares, required] = (await publicClient.readContract({
    ...target,
    functionName: 'previewDeposit',
    args: [tokens, offered],
  })) as readonly [bigint, readonly bigint[]];
  console.log(`  preview: ${fmt(previewShares, decimals)} ${symbol}`);
  console.log(`  required: ${required.map((v, i) => `${fmt(v, meta[i].decimals)} ${meta[i].symbol}`).join(' + ')}`);
  assert(required.every((v, i) => v <= offered[i]), 'required ≤ offered for every token');
  assert(
    required.every((v, i) => (offered[i] - v) * 1_000_000n <= offered[i]),
    'a proportional offer is pulled in full — every token within 1 ppm of its offer',
  );

  const demoSharesBefore = await sharesOf(defaultTarget);
  const walletBefore = await Promise.all(meta.map((t) => balanceOf(t.address)));
  const sharesBefore = await sharesOf(target);
  const minShares = (previewShares * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  const depositReceipt = await send(
    await walletClient.writeContract({ ...target, functionName: 'deposit', args: [tokens, offered, minShares, account.address] }),
    'stocks deposit',
  );
  const deposited = parseEventLogs({ abi: vaultAbi, logs: depositReceipt.logs, eventName: 'Deposited' });
  assert(deposited.length === 1 && deposited[0].address.toLowerCase() === target.address.toLowerCase(), 'Deposited was emitted by the stocks vault');
  const minted = (deposited[0].args as { shares: bigint }).shares;
  const pulled = (deposited[0].args as { amounts: readonly bigint[] }).amounts;
  const mintTransfer = parseEventLogs({ abi: vaultAbi, logs: depositReceipt.logs, eventName: 'Transfer' }).find(
    (e) => e.address.toLowerCase() === target.address.toLowerCase(),
  );
  assert(minted === previewShares, 'minted == previewDeposit', `${fmt(minted, decimals)} ${symbol}`);
  assert(pulled.every((v, i) => v === required[i]), 'Deposited amounts == requiredAmounts (all six tokens)');
  assert((mintTransfer?.args as { value?: bigint } | undefined)?.value === minted, 'the receipt token minted is the stocks vault itself (ERC-20 Transfer from the vault)');
  const walletAfter = await Promise.all(meta.map((t) => balanceOf(t.address)));
  assert(walletAfter.every((w, i) => walletBefore[i] - w === required[i]), 'each of the six wallet balances fell by exactly its required amount');
  const sharesAfter = await sharesOf(target);
  assert(sharesAfter - sharesBefore === minted, `${symbol} balance grew by the minted shares`, fmt(sharesAfter, decimals));
  assert((await sharesOf(defaultTarget)) === demoSharesBefore, `the default vault's ${DEFAULT_VAULT.receipt.symbol} balance is untouched`);

  // Redeem a third of what was just minted.
  const part = minted / 3n;
  const [, owed] = (await publicClient.readContract({ ...target, functionName: 'previewRedeem', args: [part] })) as readonly [
    readonly Address[],
    readonly bigint[],
  ];
  console.log(`  redeeming ${fmt(part, decimals)} ${symbol} → ${owed.map((v, i) => `${fmt(v, meta[i].decimals)} ${meta[i].symbol}`).join(' + ')}`);
  const preRedeem = await Promise.all(meta.map((t) => balanceOf(t.address)));
  const supplyMid = (await publicClient.readContract({ ...target, functionName: 'totalSupply' })) as bigint;
  const redeemReceipt = await send(
    await walletClient.writeContract({ ...target, functionName: 'redeem', args: [part, account.address] }),
    'stocks redeem',
  );
  const redeemed = parseEventLogs({ abi: vaultAbi, logs: redeemReceipt.logs, eventName: 'Redeemed' })[0];
  const delivered = (redeemed.args as { amounts: readonly bigint[] }).amounts;
  const postRedeem = await Promise.all(meta.map((t) => balanceOf(t.address)));
  assert(delivered.every((v, i) => v === owed[i]), 'Redeemed amounts == previewRedeem (all six tokens)');
  assert(postRedeem.every((w, i) => w - preRedeem[i] === owed[i]), 'all six tokens arrived in the wallet in kind');
  assert(owed.every((v) => v > 0n), 'every basket token is part of the redemption');
  const sharesFinal = await sharesOf(target);
  const supplyFinal = (await publicClient.readContract({ ...target, functionName: 'totalSupply' })) as bigint;
  assert(sharesAfter - sharesFinal === part, `${symbol} balance fell by the redeemed shares`, fmt(sharesFinal, decimals));
  assert(supplyMid - supplyFinal === part, `${symbol} supply fell by the redeemed shares`, fmt(supplyFinal, decimals));

  const symbolAfter = (await publicClient.readContract({ ...target, functionName: 'symbol' })) as string;
  assert(
    symbolAfter === STOCKS_VAULT.receipt.symbol && symbolAfter !== DEFAULT_VAULT.receipt.symbol,
    `the receipt symbol comes back as the registry's ${STOCKS_VAULT.receipt.symbol}, distinct from the default vault's`,
    symbolAfter,
  );
}

/* ------------------------------- 9. zap in / zap out (USDG only) ------------------------------ */

/** Canonical Permit2's allowance getter — the zap's second approval layer (token → Permit2 → router). */
const permit2Abi = parseAbi([
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
]);
/** A zap deposit's refund in the route token is dust: a few base units at most (bisection + ceil pulls). */
const ZAP_DUST_UNITS = 10n;
/** Shares minted vs `previewZap`: the two-phase sizing lands within ~0.1 bps; allow 1 bps. */
const ZAP_PREVIEW_TOLERANCE_BPS = 1n;

async function zapRoundTrip(): Promise<void> {
  const periphery = LOCAL_DEPLOYMENT.periphery;
  if (!periphery?.zapIn || !periphery.zapOut) {
    section('9. zap in / zap out — skipped (this stack registers no zap periphery)');
    return;
  }
  const zapIn = { address: periphery.zapIn as Address, abi: zapInCallAbi } as const;
  const zapOut = { address: periphery.zapOut as Address, abi: zapOutCallAbi } as const;
  const vault = { address: VAULT, abi: vaultAbi } as const;
  const bps = ZAP_DEFAULT_SLIPPAGE_BPS;
  const me = account.address;

  const tokens = (await publicClient.readContract({ ...vault, functionName: 'tokens' })) as readonly Address[];
  const meta = await Promise.all(
    tokens.map(async (address) => ({
      address,
      symbol: (await publicClient.readContract({ address, abi: erc20Abi, functionName: 'symbol' })) as string,
      decimals: Number(await publicClient.readContract({ address, abi: erc20Abi, functionName: 'decimals' })),
    })),
  );
  const ui = meta.findIndex((t) => t.symbol === ZAP_ROUTE_SYMBOL);
  const usdg = meta[ui];
  const others = meta.filter((_, i) => i !== ui);
  const decimals = Number(await publicClient.readContract({ ...vault, functionName: 'decimals' }));
  const symbol = (await publicClient.readContract({ ...vault, functionName: 'symbol' })) as string;
  const bal = (token: Address, who: Address) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
  const allowance = (token: Address, owner: Address, spender: Address) =>
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] });
  const permit2Amount = async (permit2: Address, owner: Address, token: Address, spender: Address) =>
    (await publicClient.readContract({ address: permit2, abi: permit2Abi, functionName: 'allowance', args: [owner, token, spender] }))[0];

  /* --------------------------------------- 9a. zap deposit --------------------------------------- */
  section(`9a. zap deposit — ${ZAP_ROUTE_SYMBOL} only into ${DEFAULT_VAULT.key} (${zapIn.address})`);
  assert(ui !== -1, `the default basket holds the route token ${ZAP_ROUTE_SYMBOL}`, usdg?.address);
  const registeredIn = await publicClient.readContract({ ...zapIn, functionName: 'isVaultRegistered', args: [VAULT] });
  assert(registeredIn, 'zap-in has the default vault registered');
  const [permit2In, routerIn] = await Promise.all([
    publicClient.readContract({ ...zapIn, functionName: 'PERMIT2' }),
    publicClient.readContract({ ...zapIn, functionName: 'UNIVERSAL_ROUTER' }),
  ]);
  for (const o of others) {
    const route = await publicClient.readContract({ ...zapIn, functionName: 'routes', args: [usdg.address, o.address] });
    assert(route[0] !== '0x0000000000000000000000000000000000000000', `zap-in route ${usdg.symbol} → ${o.symbol} is set`, `pool ${route[0]} · fee ${route[1]} · cap ${route[3]} bps`);
    assert(bps <= route[3], `the UI default tolerance (${bps} bps) is within the route cap`, `${route[3]} bps`);
  }

  const amountIn = 1_000n * 10n ** BigInt(usdg.decimals);
  assert(parseZapDepositAmount('1000', usdg.decimals)?.ok === true && zapSizeWarning(amountIn, usdg.decimals) === null, 'the UI accepts 1,000 USDG with no size warning');
  const [, offers, expectedShares, expectedRefunds] = await publicClient.readContract({
    ...zapIn,
    functionName: 'previewZap',
    args: [VAULT, usdg.address, amountIn, bps],
  });
  const minShares = zapMinimum(expectedShares, bps);
  console.log(`  zapping ${fmt(amountIn, usdg.decimals)} ${usdg.symbol} at ${bps} bps`);
  console.log(`  previewZap: offer ${offers.map((v, i) => `${fmt(v, meta[i].decimals)} ${meta[i].symbol}`).join(' + ')} → ${fmt(expectedShares, decimals)} ${symbol} · refunds ${expectedRefunds.map((v, i) => `${v} ${meta[i].symbol}`).join(', ')} (base units)`);
  console.log(`  minShares (UI math, ${bps} bps): ${fmt(minShares, decimals)} ${symbol}`);
  assert(expectedShares > 0n && minShares > 0n && minShares < expectedShares, 'previewZap quotes shares and minShares is a non-zero haircut of it');

  await send(await walletClient.writeContract({ address: usdg.address, abi: erc20Abi, functionName: 'approve', args: [zapIn.address, amountIn] }), 'approve USDG → zap');
  const approved = await allowance(usdg.address, me, zapIn.address);
  assert(approved === amountIn, 'USDG approved to the ZAP for exactly the offer', `expected ${fmt(amountIn, usdg.decimals)} · actual ${fmt(approved, usdg.decimals)}`);

  const walletBefore = await Promise.all(meta.map((t) => bal(t.address, me)));
  const sharesBefore = await publicClient.readContract({ ...vault, functionName: 'balanceOf', args: [me] });
  const supplyBefore = await publicClient.readContract({ ...vault, functionName: 'totalSupply' });
  const zapReceipt = await send(
    await walletClient.writeContract({ ...zapIn, functionName: 'zapDeposit', args: [VAULT, usdg.address, amountIn, minShares, bps, me] }),
    'zapDeposit',
  );
  const zapped = parseEventLogs({ abi: zapInAbi, logs: zapReceipt.logs, eventName: 'ZapDeposited' })[0];
  const minted = zapped.args.shares;
  const refunds = parseEventLogs({ abi: zapInAbi, logs: zapReceipt.logs, eventName: 'ZapRefunded' });
  const refundOf = (token: Address) =>
    refunds.filter((e) => e.args.token.toLowerCase() === token.toLowerCase()).reduce((s, e) => s + e.args.amount, 0n);
  const walletAfter = await Promise.all(meta.map((t) => bal(t.address, me)));
  const sharesAfter = await publicClient.readContract({ ...vault, functionName: 'balanceOf', args: [me] });
  const supplyAfter = await publicClient.readContract({ ...vault, functionName: 'totalSupply' });

  const gap = minted > expectedShares ? minted - expectedShares : expectedShares - minted;
  const gapPpm = (gap * 1_000_000n) / expectedShares;
  assert(minted >= minShares, 'minted ≥ minShares', `minShares ${fmt(minShares, decimals)} · minted ${fmt(minted, decimals)}`);
  assert(
    gap * 10_000n <= expectedShares * ZAP_PREVIEW_TOLERANCE_BPS,
    `minted ≈ previewZap (within ${ZAP_PREVIEW_TOLERANCE_BPS} bps)`,
    `expected ${fmt(expectedShares, decimals)} · actual ${fmt(minted, decimals)} · gap ${gapPpm} ppm`,
  );
  assert(sharesAfter - sharesBefore === minted, `${symbol} balance grew by exactly the ZapDeposited shares`, `expected ${fmt(minted, decimals)} · actual ${fmt(sharesAfter - sharesBefore, decimals)}`);
  assert(supplyAfter - supplyBefore === minted, `${symbol} supply grew by the minted shares`);
  const usdgRefund = refundOf(usdg.address);
  const usdgSpent = walletBefore[ui] - walletAfter[ui];
  assert(usdgSpent === amountIn - usdgRefund, 'wallet USDG fell by the offer minus the refund', `expected ${fmt(amountIn - usdgRefund, usdg.decimals)} · actual ${fmt(usdgSpent, usdg.decimals)}`);
  assert(usdgRefund <= ZAP_DUST_UNITS, `the USDG refund is dust (≤ ${ZAP_DUST_UNITS} base units) — the offer is consumed`, `refund ${usdgRefund} base units`);
  for (const o of others) {
    const i = meta.indexOf(o);
    const delta = walletAfter[i] - walletBefore[i];
    assert(delta === refundOf(o.address), `${o.symbol}: the wallet received exactly the ZapRefunded amount (no other ${o.symbol} moved)`, `refund ${delta} base units`);
  }
  const allowanceAfter = await allowance(usdg.address, me, zapIn.address);
  assert(allowanceAfter === 0n, 'user → zap USDG allowance consumed to 0', `expected 0 · actual ${allowanceAfter}`);
  const [erc20ToPermit2, permit2ToRouter] = await Promise.all([
    allowance(usdg.address, zapIn.address, permit2In),
    permit2Amount(permit2In, zapIn.address, usdg.address, routerIn),
  ]);
  assert(erc20ToPermit2 === 0n && permit2ToRouter === 0n, 'both Permit2 layers of the zap are zeroed (USDG → Permit2, Permit2 → router)', `erc20 ${erc20ToPermit2} · permit2 ${permit2ToRouter}`);
  for (const t of meta) {
    const [left, toVault] = await Promise.all([bal(t.address, zapIn.address), allowance(t.address, zapIn.address, VAULT)]);
    assert(left === 0n && toVault === 0n, `zap-in holds no ${t.symbol} and leaves no ${t.symbol} allowance to the vault`, `balance ${left} · allowance ${toVault}`);
  }

  /* ----------------------------------------- 9b. zap exit ---------------------------------------- */
  section(`9b. zap exit — ${symbol} → ${ZAP_ROUTE_SYMBOL} only (${zapOut.address})`);
  const registeredOut = await publicClient.readContract({ ...zapOut, functionName: 'isVaultRegistered', args: [VAULT] });
  assert(registeredOut, 'zap-out has the default vault registered');
  const [permit2Out, routerOut] = await Promise.all([
    publicClient.readContract({ ...zapOut, functionName: 'PERMIT2' }),
    publicClient.readContract({ ...zapOut, functionName: 'UNIVERSAL_ROUTER' }),
  ]);

  const shares = minted; // exit exactly what the zap just minted
  assert(parseZapRedeemShares(toExactString(shares, decimals), decimals, sharesAfter)?.ok === true, 'the UI accepts the minted shares as a redeem amount');
  const [, sold, expectedOut, passThrough] = await publicClient.readContract({
    ...zapOut,
    functionName: 'previewRedeem',
    args: [VAULT, usdg.address, shares, bps],
  });
  const minOut = zapMinimum(expectedOut, bps);
  console.log(`  redeeming ${fmt(shares, decimals)} ${symbol} at ${bps} bps`);
  console.log(`  previewRedeem: sells ${sold.map((v, i) => `${fmt(v, meta[i].decimals)} ${meta[i].symbol}`).join(' + ')} → ${fmt(expectedOut, usdg.decimals)} ${usdg.symbol} · pass-through ${passThrough.map((v, i) => `${v} ${meta[i].symbol}`).join(', ')}`);
  console.log(`  minAmountOut (UI math, ${bps} bps): ${fmt(minOut, usdg.decimals)} ${usdg.symbol}`);
  assert(expectedOut > 0n && minOut > 0n && minOut < expectedOut, 'previewRedeem quotes USDG and the minimum is a non-zero haircut of it');
  assert(passThrough.every((v) => v === 0n), 'every non-USDG token has a route — nothing is passed through in kind');

  await send(await walletClient.writeContract({ ...vault, functionName: 'approve', args: [zapOut.address, shares] }), `approve ${symbol} → zap`);
  const sharesApproved = await publicClient.readContract({ ...vault, functionName: 'allowance', args: [me, zapOut.address] });
  assert(sharesApproved === shares, `${symbol} approved to the zap-out for exactly the shares`, `expected ${fmt(shares, decimals)} · actual ${fmt(sharesApproved, decimals)}`);

  const exitWalletBefore = await Promise.all(meta.map((t) => bal(t.address, me)));
  const exitSupplyBefore = await publicClient.readContract({ ...vault, functionName: 'totalSupply' });
  const exitReceipt = await send(
    await walletClient.writeContract({ ...zapOut, functionName: 'zapRedeem', args: [VAULT, usdg.address, shares, minOut, bps, me] }),
    'zapRedeem',
  );
  const redeemedEv = parseEventLogs({ abi: zapOutAbi, logs: exitReceipt.logs, eventName: 'ZapRedeemed' })[0];
  const passEvents = parseEventLogs({ abi: zapOutAbi, logs: exitReceipt.logs, eventName: 'ZapPassThrough' });
  const exitWalletAfter = await Promise.all(meta.map((t) => bal(t.address, me)));
  const exitShares = await publicClient.readContract({ ...vault, functionName: 'balanceOf', args: [me] });
  const exitSupply = await publicClient.readContract({ ...vault, functionName: 'totalSupply' });
  const usdgIn = exitWalletAfter[ui] - exitWalletBefore[ui];

  assert(usdgIn === redeemedEv.args.amountOut, 'wallet USDG grew by exactly the ZapRedeemed amountOut', `event ${fmt(redeemedEv.args.amountOut, usdg.decimals)} · wallet ${fmt(usdgIn, usdg.decimals)}`);
  assert(usdgIn >= minOut, 'USDG received ≥ the previewed minimum', `minimum ${fmt(minOut, usdg.decimals)} · received ${fmt(usdgIn, usdg.decimals)} · preview ${fmt(expectedOut, usdg.decimals)} (${usdgIn - expectedOut} base units vs preview)`);
  assert(redeemedEv.args.shares === shares && sharesAfter - exitShares === shares, `${symbol} burned: exactly the redeemed shares left the wallet`, `expected ${fmt(shares, decimals)} · actual ${fmt(sharesAfter - exitShares, decimals)}`);
  assert(exitSupplyBefore - exitSupply === shares, `${symbol} supply fell by the redeemed shares`);
  assert(passEvents.length === 0 && others.every((o) => exitWalletAfter[meta.indexOf(o)] === exitWalletBefore[meta.indexOf(o)]), 'no pass-through: only USDG reached the wallet');
  const sharesAllowanceAfter = await publicClient.readContract({ ...vault, functionName: 'allowance', args: [me, zapOut.address] });
  assert(sharesAllowanceAfter === 0n, `user → zap-out ${symbol} allowance consumed to 0`, `actual ${sharesAllowanceAfter}`);
  for (const o of others) {
    const [erc20Layer, permit2Layer] = await Promise.all([allowance(o.address, zapOut.address, permit2Out), permit2Amount(permit2Out, zapOut.address, o.address, routerOut)]);
    assert(erc20Layer === 0n && permit2Layer === 0n, `both Permit2 layers of the zap-out are zeroed for ${o.symbol}`, `erc20 ${erc20Layer} · permit2 ${permit2Layer}`);
  }
  const zapLeft = await Promise.all([...meta.map((t) => bal(t.address, zapOut.address)), publicClient.readContract({ ...vault, functionName: 'balanceOf', args: [zapOut.address] })]);
  assert(zapLeft.every((v) => v === 0n), `zap-out dust is zero (${[...meta.map((t) => t.symbol), symbol].join(', ')})`, zapLeft.map(String).join(', '));
}

main().catch((err: unknown) => {
  console.error('\ne2e FAILED');
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
