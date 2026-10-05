/**
 * MySun brand + receipt naming (notes/NAMING.md, 2026-10-05): the shell's product name, the page
 * title, the demo markets' `sun<Strategy>LP` receipts — and the migration boundary: a vault already
 * deployed keeps the receipt it was initialized with (no setter), so its registry entry stays as is.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BRAND } from '@/lib/brand';
import { VAULTS } from '@/demo/data/vaults';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('brand', () => {
  it('the shell and the page title say MySun', () => {
    expect(BRAND.name).toBe('MySun');
    expect(read('../../index.html')).toMatch(/<title>MySun — /);
  });
});

describe('receipt naming — sun<Strategy>LP', () => {
  it('maps every demo market to its strategy receipt', () => {
    expect(Object.fromEntries(VAULTS.map((v) => [v.id, v.receiptSymbol]))).toEqual({
      'eth-usdg': 'sunEthLP',
      'nvda-usdg': 'sunNvdaLP',
      'pons-eth': 'sunPonsEthLP',
      'spcx-usdg': 'sunSpcxLP',
      'pons-usdg': 'sunPonsLP',
      'cashcat-eth': 'sunCashcatEthLP',
      'spy-eth': 'sunSpyEthLP',
    });
    for (const v of VAULTS) expect(v.receiptSymbol).toMatch(/^sun[A-Z0-9][A-Za-z0-9]*LP$/);
  });

  it('the deployed Robinhood Chain vault keeps the receipt it was initialized with', () => {
    // name()/symbol() are fixed on-chain; the 4663 rehearsal vault was withdrawn + redeployed as
    // sunEthLP (2026-10-05), so the registry entry tracks the receipt it was initialized with.
    const registry = JSON.parse(read('../../../shared/deployments.json')) as {
      chains: Record<string, { vaults: { key: string; receipt: { name: string; symbol: string } }[] }>;
    };
    expect(registry.chains['4663'].vaults.map((v) => [v.key, v.receipt])).toEqual([
      ['main', { name: 'sunEthLP', symbol: 'sunEthLP' }],
    ]);
  });
});
