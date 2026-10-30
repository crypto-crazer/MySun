/**
 * The vault chart's illustrative fallback (src/demo/series.ts). The prototype's mock-market math
 * (emissions, PMG APR, demo portfolio, zap/withdraw previews) was retired with src/demo/math.ts;
 * the live zap math is pinned in zap.test.ts and the fee APR in feeApy.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { navSeries } from '@/demo/series';

describe('chart series', () => {
  it('NAV series starts at exactly 1.0 and ends at pricePerShare / benchmark', () => {
    const s = navSeries('4663-main', 1.0032, 0.0032, 30);
    expect(s[0].tdlp).toBeCloseTo(1, 10);
    expect(s[0].hodl).toBeCloseTo(1, 10);
    expect(s[29].tdlp).toBeCloseTo(1.0032, 10);
    expect(s[29].hodl).toBeCloseTo(1.0, 10);
  });
});
