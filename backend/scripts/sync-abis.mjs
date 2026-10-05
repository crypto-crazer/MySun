#!/usr/bin/env node
/**
 * Regenerate `src/abi/generated.ts` from `../shared/abis/*.json`.
 *
 * `shared/` is the monorepo's single source of truth for ABIs, but the keeper must be buildable
 * from the `backend/` directory alone (the Docker build context is `backend/`), so the generated
 * TypeScript is committed. Re-run `pnpm run sync-abis` whenever the contracts change.
 *
 * Only the entries the keeper actually uses are emitted — a narrow ABI keeps viem's type
 * inference fast and makes accidental use of owner-only functions a compile error.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sharedAbis = resolve(here, '../../shared/abis');
const outFile = resolve(here, '../src/abi/generated.ts');

/** Sentinel usable in `keep`: retain every `type: "error"` member. */
const ALL_ERRORS = '*errors';

/**
 * Exported const name -> { file, keep } where `keep` lists the ABI members to retain.
 * `keep` entries are matched on `name` (errors/events/functions alike).
 */
const SELECTION = [
  {
    exportName: 'vaultAbi',
    file: 'MySunVaultUpgradeable.json',
    keep: [
      // keeper-callable
      'deployTo',
      'rebalance',
      // keeper-callable, strategy layer P1/P3 (also what PlanExecutor components call)
      'addLiquidity',
      'removeLiquidity',
      'swapExactIn',
      // views the keeper reads
      'tokens',
      'totalTokens',
      'adapters',
      'adapterCount',
      'isKeeper',
      'isAdapter',
      'isToken',
      'paused',
      'performanceFeeBps',
      'treasury',
      'balanceOf',
      'totalSupply',
      // per-adapter capability bits gating addLiquidity/removeLiquidity (CAP_LIQUIDITY) and swapExactIn (CAP_SWAP)
      'adapterCapabilities',
      'CAP_LIQUIDITY',
      'CAP_SWAP',
      // events the keeper decodes from its own receipts
      'Deployed',
      'Rebalanced',
      'PerformanceFeeAccrued',
      'LiquidityAdded',
      'LiquidityRemoved',
      'SwapSettled',
      // every custom error, so failures decode to a readable name
      ALL_ERRORS,
    ],
  },
  {
    // Strategy layer P3 periphery: the keeper submits plans; `setKeeper` (owner-only) stays out.
    exportName: 'planExecutorAbi',
    file: 'PlanExecutor.json',
    keep: [
      'executePlan',
      'nonces',
      'isKeeper',
      'VAULT',
      'KIND_HARVEST',
      'KIND_SWAP',
      'KIND_ADD_LIQUIDITY',
      'KIND_REMOVE_LIQUIDITY',
      'KIND_CLOSE_POSITION',
      'PlanExecuted',
      'KeeperSet',
      ALL_ERRORS,
    ],
  },
  {
    // ILiquidityAdapter reads for plan composition (pins, bounds, sizing) — one ABI for both venues:
    // every member is taken from the v3 export and must be byte-identical in the v4 one (`sameIn`).
    // Views + events only: the adapters' mutators are vault-only, their setters owner-only. Errors are
    // venue-prefixed (UniswapV3Adapter__… / UniswapV4Adapter__…), so none are shared — none kept.
    exportName: 'liquidityAdapterAbi',
    file: 'UniswapV3Adapter.json',
    sameIn: ['UniswapV4Adapter.json'],
    keep: [
      'positionState',
      'previewAddLiquidity',
      'rangeConstraints',
      'minTick',
      'maxTick',
      'minRangeTicks',
      'maxRangeTicks',
      'tokenId',
      'tickLower',
      'tickUpper',
      'TOKEN0',
      'TOKEN1',
      'TICK_SPACING',
      'POOL_FEE',
      'VAULT',
      'twapTick',
      'twapWindow',
      'maxSlippageBps',
      'dex',
      'poolId',
      'position',
      'LiquidityAdded',
      'LiquidityRemoved',
      'IdleRefunded',
    ],
  },
  {
    exportName: 'positionAdapterAbi',
    file: 'IPositionAdapter.json',
    keep: ['position', 'dex', 'poolId'],
  },
  {
    exportName: 'erc20Abi',
    file: 'MockToken.json',
    keep: ['balanceOf', 'allowance', 'totalSupply'],
  },
  {
    // Test-only helper: `simulateFees` is permissionless on the local mock adapter and is used by
    // the integration tests to seed harvestable fees. Never called by the keeper itself.
    exportName: 'mockAdapterTestAbi',
    file: 'MockPositionAdapter.json',
    keep: ['simulateFees', 'deployed', 'harvestable', 'position'],
  },
];

function selectMembers(file, abi, keep) {
  const wantsAllErrors = keep.includes(ALL_ERRORS);
  const names = new Set(keep.filter((k) => k !== ALL_ERRORS));
  // A renamed / removed member must fail the sync, not silently drop out of the keeper's ABI.
  const missing = [...names].filter((n) => !abi.some((m) => m.name === n));
  if (missing.length > 0) throw new Error(`${file} has no member named ${missing.join(', ')}`);
  return abi.filter((m) => {
    if (m.type === 'error' && wantsAllErrors) return true;
    return typeof m.name === 'string' && names.has(m.name);
  });
}

/** Every picked member must exist, byte-identical (type, name, inputs, outputs, mutability), in each `sameIn` file. */
function assertSameIn(file, picked, sameIn) {
  for (const other of sameIn) {
    const abi = JSON.parse(readFileSync(resolve(sharedAbis, other), 'utf8'));
    for (const m of picked) {
      const twin = abi.find((o) => o.type === m.type && o.name === m.name);
      if (twin === undefined || JSON.stringify(twin) !== JSON.stringify(m)) {
        throw new Error(`${file}: ${m.type} ${m.name} is not identical in ${other} — drop it from the shared selection`);
      }
    }
  }
}

const chunks = [
  '// AUTO-GENERATED by `pnpm run sync-abis` from ../../shared/abis/*.json — do not edit by hand.',
  '// shared/abis is the monorepo source of truth; this file is committed so that `backend/`',
  '// builds standalone (Docker build context is `backend/`).',
  '',
];

for (const { exportName, file, keep, sameIn = [] } of SELECTION) {
  const abi = JSON.parse(readFileSync(resolve(sharedAbis, file), 'utf8'));
  const picked = selectMembers(file, abi, keep);
  if (picked.length === 0) throw new Error(`no ABI members selected from ${file}`);
  assertSameIn(file, picked, sameIn);
  const also = sameIn.length > 0 ? ` (identical in ${sameIn.join(', ')})` : '';
  chunks.push(`/** Selected from shared/abis/${file}${also}. */`);
  chunks.push(`export const ${exportName} = ${JSON.stringify(picked, null, 2)} as const;`);
  chunks.push('');
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, chunks.join('\n'));
console.log(`wrote ${outFile}`);
for (const { exportName, file, sameIn = [] } of SELECTION) {
  console.log(`  ${exportName} <- ${file}${sameIn.length > 0 ? ` (= ${sameIn.join(', ')})` : ''}`);
}
