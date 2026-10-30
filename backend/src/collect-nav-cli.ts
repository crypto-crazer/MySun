/**
 * Entrypoint for the NAV/fee snapshot collector — legacy (superseded by the Cloudflare Worker
 * `mysun-analytics`, see backend/cf-analytics). Kept for reference and local `once` runs.
 *
 *   node dist/collect-nav-cli.js once      # one snapshot cycle, then exit
 *   node dist/collect-nav-cli.js serve     # snapshot every COLLECT_INTERVAL_MIN + HTTP (default)
 *
 * Env: REGISTRY_DIR (default ../shared from this file), DATA_DIR (default backend/data),
 * PORT (default 8080), COLLECT_INTERVAL_MIN (default 60).
 *
 * Read-only: no signer, no transactions. See collect-nav.ts for the invariant restated there.
 */

import { collectOnce, runLoop } from './collect-nav.js';

const args = process.argv.slice(1);

async function main(): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      'mysun-collect: snapshot NAV + fees for every deployed vault into a JSONL, serve it over HTTP.\n' +
        '  once   — run one snapshot cycle and exit\n' +
        '  serve  — snapshot every COLLECT_INTERVAL_MIN and serve the file (default)\n',
    );
    return 0;
  }
  if (args.includes('once')) {
    const { wrote, chains } = await collectOnce();
    process.stdout.write(`collect done: ${wrote} rows across ${chains} chains\n`);
    return 0;
  }
  await runLoop();
  // serve() has bound the port but must not return and exit — keep the process alive forever.
  await new Promise(() => {});
  return 0;
}

main().then((exit) => process.exit(exit)).catch((err) => {
  process.stderr.write(`collector fatal: ${String(err)}\n`);
  process.exit(1);
});