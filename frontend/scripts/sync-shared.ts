/**
 * sync:shared — regenerate `src/config/generated.ts` from the monorepo's `shared/` directory.
 *
 * Inputs:
 *   - `shared/deployments.json` — the multi-chain registry (v2): every chain the app knows and, for
 *     each chain MySun is deployed on, its `vaults` list. Adding a chain or a vault = one entry
 *     there + this.
 *   - `shared/deployment.local.json` — the local demo stack (written by DemoLocal.s.sol, or by
 *     DemoLocalFork.s.sol on an RHC fork). Overlaid on the registry entry with the same chain id:
 *     deployed, `local: true`, its rpcUrl + vaults, and the optional `fork` / `mintable` flags
 *     (plus `periphery` = the chain's zap / PlanExecutor addresses, when the stack has them).
 *   - `shared/abis/*.json` — the ABIs.
 * Nothing in the frontend may hand-copy any of them. The emitted file IS committed so `pnpm build`
 * works standalone (e.g. CI without the contracts checkout).
 *
 * Validation lives in ./registry.ts and throws with the offending path/key. The output depends only
 * on the inputs (fixed key order, no timestamps), so re-running it on unchanged inputs is a no-op.
 *
 * Usage: pnpm sync:shared
 *        tsx scripts/sync-shared.ts --prod   — production-bundle variant: the `local` demo chain is
 *        omitted (cf-worker/deploy.sh writes it before `pnpm build` and restores the committed file
 *        afterwards; never commit it).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadShared, renderGenerated } from './generate';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, '..');
const sharedDir = resolve(frontend, '..', 'shared');
const outFile = resolve(frontend, 'src/config/generated.ts');

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--prod');
if (unknown.length > 0) throw new Error(`sync:shared: unknown argument(s) ${unknown.join(' ')} (only --prod)`);
const omitLocal = args.includes('--prod');

const inputs = loadShared(sharedDir);
const { abis } = inputs;
const chains = omitLocal ? inputs.chains.filter((c) => !c.local) : inputs.chains;

const out = renderGenerated(inputs, { omitLocal });

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, out);
console.log(`sync:shared${omitLocal ? ' --prod' : ''} → ${outFile}`);
console.log(`  chains: ${chains.map((c) => c.chainId).join(', ')}`);
for (const c of chains) {
  const flags = [c.fork ? 'FORK' : '', c.mintable === false ? 'not mintable' : ''].filter(Boolean).join(', ');
  const tag = c.local ? `deployed · LOCAL (deployment.local.json)${flags ? ` · ${flags}` : ''}` : c.status;
  console.log(`    ${String(c.chainId).padEnd(8)} ${c.name} — ${tag} · rpc ${c.rpcUrl}`);
  for (const v of c.vaults ?? []) console.log(`             vault ${v.key.padEnd(10)} ${v.vault} · ${v.receipt.symbol} · ${v.label}`);
  if (c.periphery) {
    const p = c.periphery;
    console.log(`             periphery  zapIn ${p.zapIn ?? '—'} · zapOut ${p.zapOut ?? '—'} · planExecutor ${p.planExecutor ?? '—'}`);
  }
}
if (omitLocal) console.log('  (--prod: local demo chain omitted — production-bundle variant, do not commit)');
else if (!inputs.hasLocal) console.log('  (no shared/deployment.local.json — no local chain)');
console.log(
  `  abis: vault(${abis.vault.length}) mockToken(${abis.mockToken.length}) adapter(${abis.positionAdapter.length}) ` +
    `mockAdapter(${abis.mockAdapter.length}) zapIn(${abis.zapIn.length}) zapOut(${abis.zapOut.length})`,
);
