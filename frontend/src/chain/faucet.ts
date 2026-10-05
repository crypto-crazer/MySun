/**
 * The fork stack's faucet, behind "Fund my wallet" in the local dev tools (and asserted by
 * `e2e:local`). The RHC fork's basket tokens are REAL — nothing can be minted and a fresh wallet
 * starts empty — so funding sends the selected vault's basket tokens over, per token:
 *
 *  - a MockToken (the `stocks` vault's six) through its public `mint`;
 *  - a real token through a `transfer`,
 *  both sent from an ANVIL-IMPERSONATED FORK_FAUCET_POOL (the v3 fee-100 pool — the fork demo's
 *  funding source, `contracts/script/fork-demo-up.sh`). No wallet signature is involved either
 *  way: the connected wallet only names the destination.
 *
 * A wallet with no ETH cannot sign anything, so funding FIRST tops the wallet up to 1 ETH through
 * `anvil_setBalance` (`fundEth`): a wallet this app never holds keys for can then approve, deposit
 * and (on the mock stack) mint by itself; an Anvil account already at ~10k ETH is left untouched.
 *
 * `anvil_impersonateAccount` / `anvil_setBalance` exist on a local node only; the buttons that
 * call this render only for the local stack (`isLocalChain`), never for a registry chain. Which
 * path a token takes is decided by SIMULATION of `mint` (USDG/WETH revert, the mock's succeeds),
 * so a redeployed stack needs no hardcoded token list.
 */
import { createClient, http, parseAbi, type Address, type Chain, type Client, type Hash, type Transport } from 'viem';
// Standalone actions, not `createWalletClient` — see src/wallet/WalletProvider.tsx.
import { getBalance, simulateContract, writeContract } from 'viem/actions';
import { waitForReceipt } from './client';
import { chainFor } from './chains';

/** The v3 USDG/WETH 0.01% pool — the fork demo's funding source (contracts/script/fork-demo-up.sh). */
export const FORK_FAUCET_POOL = '0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca' as Address;

/** Every wallet funded through the local dev tools is raised to at least this much ETH for gas. */
export const FAUCET_ETH_TOPUP = 10n ** 18n; // 1 ETH

const erc20Abi = parseAbi(['function transfer(address to, uint256 value) returns (bool)']);
const mintAbi = parseAbi(['function mint(address to, uint256 amount)']);

/** What one faucet click sends per token: 10 of an 18-decimal token, 10k of a 6-decimal one. */
export function faucetAmount(decimals: number): bigint {
  return (decimals >= 12 ? 10n : 10_000n) * 10n ** BigInt(decimals);
}

/** A client to the chain's own RPC — the impersonated path never goes through the user's wallet. */
function rpcClient(chainId: number): Client<Transport, Chain> {
  const chain = chainFor(chainId);
  if (!chain) throw new Error(`Chain ${chainId} is not in the registry (shared/deployments.json).`);
  return createClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
}

/** `mint` (a MockToken) or `transfer` (a real token) — decided by simulating the mint. */
export async function faucetKind(chainId: number, token: Address, to: Address, amount: bigint): Promise<'mint' | 'transfer'> {
  try {
    await simulateContract(rpcClient(chainId), {
      address: token,
      abi: mintAbi,
      functionName: 'mint',
      args: [to, amount],
      account: to,
    } as never);
    return 'mint';
  } catch {
    return 'transfer';
  }
}

/**
 * Make sure `to` holds at least `minBalance` wei of ETH — `anvil_setBalance`, LOCAL NODE ONLY.
 * Called before anything asks the user's own wallet to sign (approve / deposit / the mock `mint`
 * all spend gas the wallet must already have). A balance at/above the floor is never touched —
 * Anvil's funded accounts stay at ~10,000 ETH. Returns the balance read back.
 */
export async function fundEth(chainId: number, to: Address, minBalance: bigint = FAUCET_ETH_TOPUP): Promise<bigint> {
  const client = rpcClient(chainId);
  const current = await getBalance(client, { address: to });
  if (current >= minBalance) return current;
  await client.request({ method: 'anvil_setBalance', params: [to, `0x${minBalance.toString(16)}`] } as never);
  const after = await getBalance(client, { address: to });
  if (after < minBalance) throw new Error('The local node did not apply the ETH top-up (anvil_setBalance unsupported?).');
  return after;
}

/**
 * Send `amount` of `token` to `to` FROM an anvil-impersonated FORK_FAUCET_POOL: the public `mint`
 * for a MockToken (`kind`, as `faucetKind` just simulated), a `transfer` for a real token. LOCAL
 * NODE ONLY: `anvil_impersonateAccount` must exist on the RPC and, on the transfer path, the pool
 * must hold the token. No wallet signature is involved — the wallet only names the destination.
 * Resolves once the call is mined and successful.
 */
export async function impersonatedFund(
  chainId: number,
  kind: 'mint' | 'transfer',
  token: Address,
  to: Address,
  amount: bigint,
): Promise<Hash> {
  const client = rpcClient(chainId);
  const chain = chainFor(chainId);
  await client.request({ method: 'anvil_impersonateAccount', params: [FORK_FAUCET_POOL] } as never);
  try {
    // Gas money for the pool: idempotent, and the pool spends a little on every send.
    await client.request({ method: 'anvil_setBalance', params: [FORK_FAUCET_POOL, '0xDE0B6B3A7640000'] } as never);
    const hash = (await writeContract(client, {
      abi: kind === 'mint' ? mintAbi : erc20Abi,
      address: token,
      functionName: kind === 'mint' ? 'mint' : 'transfer',
      args: [to, amount],
      account: FORK_FAUCET_POOL,
      chain,
    } as never)) as Hash;
    const receipt = await waitForReceipt(chainId, hash);
    if (receipt.status !== 'success') {
      throw new Error(
        kind === 'mint'
          ? 'The faucet mint reverted — the token may not have a public mint.'
          : 'The faucet transfer reverted — the pool may not hold this token.',
      );
    }
    return hash;
  } finally {
    await client.request({ method: 'anvil_stopImpersonatingAccount', params: [FORK_FAUCET_POOL] } as never).catch(() => {});
  }
}
