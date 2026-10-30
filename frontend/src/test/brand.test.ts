/**
 * MySun brand + receipt naming (notes/NAMING.md, 2026-10-05): the shell's product name, the page
 * title, the registry vaults' `sun<Strategy>LP` receipts — and the migration boundary: a vault already
 * deployed keeps the receipt it was initialized with (no setter), so its registry entry stays as is.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BRAND } from '@/lib/brand';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('brand', () => {
  it('the shell and the page title say MySun', () => {
    expect(BRAND.name).toBe('MySun');
    expect(read('../../index.html')).toMatch(/<title>MySun — /);
  });
});

describe('receipt naming — sun<Strategy>LP', () => {
  it('the deployed Robinhood Chain vault keeps the receipt it was initialized with', () => {
    // name()/symbol() are fixed on-chain; the 4663 rehearsal vault was withdrawn + redeployed as
    // sunEthLP (2026-10-05), so the registry entry tracks the receipt it was initialized with.
    // The 12 stock vaults (2026-10-27) follow the same rule: registry key = market, receipt = sun<Market>LP.
    const registry = JSON.parse(read('../../../shared/deployments.json')) as {
      chains: Record<string, { vaults?: { key: string; receipt: { name: string; symbol: string } }[] }>;
    };
    expect(registry.chains['4663'].vaults?.map((v) => [v.key, v.receipt])).toEqual([
      ['main', { name: 'sunEthLP', symbol: 'sunEthLP' }],
      ['pons', { name: 'sunPonsLP', symbol: 'sunPonsLP' }],
      ['tri', { name: 'sunTriLP', symbol: 'sunTriLP' }],
      ['spy', { name: 'sunSpyLP', symbol: 'sunSpyLP' }],
      ['gld', { name: 'sunGldLP', symbol: 'sunGldLP' }],
      ['nvda', { name: 'sunNvdaLP', symbol: 'sunNvdaLP' }],
      ['spcx', { name: 'sunSpcxLP', symbol: 'sunSpcxLP' }],
      ['crcl', { name: 'sunCrclLP', symbol: 'sunCrclLP' }],
      ['tsla', { name: 'sunTslaLP', symbol: 'sunTslaLP' }],
      ['aapl', { name: 'sunAaplLP', symbol: 'sunAaplLP' }],
      ['amzn', { name: 'sunAmznLP', symbol: 'sunAmznLP' }],
      ['intc', { name: 'sunIntcLP', symbol: 'sunIntcLP' }],
      ['mu', { name: 'sunMuLP', symbol: 'sunMuLP' }],
      ['mstr', { name: 'sunMstrLP', symbol: 'sunMstrLP' }],
      ['nvda-spy', { name: 'sunNvdaSpyLP', symbol: 'sunNvdaSpyLP' }],
    ]);
    // Every receipt in the registry, every chain, follows the sun<Strategy>LP shape (this replaces the
    // check that ran over the retired prototype's mock market table).
    for (const c of Object.values(registry.chains))
      for (const v of c.vaults ?? []) expect(v.receipt.symbol).toMatch(/^sun[A-Z0-9][A-Za-z0-9]*LP$/);
  });
});
