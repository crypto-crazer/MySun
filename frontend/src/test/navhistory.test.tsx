// @vitest-environment jsdom
/**
 * NAV history from the collector (TASK-NAV-HISTORY, docs/LIVE-DATA.md):
 *  - the JSONL parser skips empty lines, a trailing partial line and garbage, never losing the rest;
 *  - the hook fetches only with a source URL, and cuts the cross-chain file per (chainId, vaultKey);
 *  - the chart draws the real series with no badge at ≥ 6 snapshots, and stays illustrative (badged)
 *    below that or without a source.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MIN_NAV_HISTORY_POINTS, navHistoryFor, parseNavHistoryJsonl } from '@/chain/navHistory';
import { useNavHistory } from '@/chain/useNavHistory';
import { NavChart } from '@/components/vault/NavChart';

/* Test-environment shim: recharts' ResponsiveContainer needs a ResizeObserver, which jsdom lacks. */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const URL_ = 'https://collector.test/analytics/nav-history.jsonl';
const T0 = Date.parse('2026-10-18T00:00:00.000Z');
const HOUR = 3_600_000;

/** A collector line, shaped like the real ones (extra fields included, ignored by the parser). */
function line(i: number, over: Record<string, unknown> = {}) {
  return JSON.stringify({
    ts: new Date(T0 + i * HOUR).toISOString(),
    chainId: 4663,
    chain: 'Robinhood Chain',
    vaultKey: 'main',
    vault: '0x0000000000000000000000000000000000000001',
    supply: '88228021170579494808',
    tokenCount: 2,
    tokens: [],
    tvlUsd: 1000 + i,
    navUsd: 1.1 + i / 1000,
    feesUsd: 0.5,
    adapterCount: 9,
    ...over,
  });
}
const body = (n: number, over: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => line(i, over)).join('\n') + '\n';

function stubFetch(text: string) {
  const fn = vi.fn(async () => new Response(text, { status: 200, headers: { 'content-type': 'text/plain' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('parseNavHistoryJsonl', () => {
  it('reads every snapshot line; keeps ts / chainId / vaultKey / navUsd (+ tvl, fees)', () => {
    const rows = parseNavHistoryJsonl(body(3));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ t: T0, ts: '2026-10-18T00:00:00.000Z', chainId: 4663, vaultKey: 'main', navUsd: 1.1, tvlUsd: 1000, feesUsd: 0.5 });
  });

  it('skips empty lines, a trailing partial line and garbage — never loses the rest', () => {
    const text = ['', line(0), '   ', 'not json', '{"ts":"x","chainId":4663,"vaultKey":"main"}', '[1,2]', 'null', line(1), line(2).slice(0, 40)].join('\n');
    const rows = parseNavHistoryJsonl(text);
    expect(rows.map((r) => r.t)).toEqual([T0, T0 + HOUR]);
  });

  it('a row without a NAV parses (navUsd undefined) and is dropped from the series', () => {
    const rows = parseNavHistoryJsonl([line(0), line(1, { navUsd: null }), line(2, { navUsd: '1.25' })].join('\n'));
    expect(rows[1].navUsd).toBeUndefined();
    expect(rows[2].navUsd).toBe(1.25);
    expect(navHistoryFor(rows, 4663, 'main').map((p) => p.navUsd)).toEqual([1.1, 1.25]);
  });

  it('navHistoryFor cuts per (chainId, vaultKey) and sorts by time', () => {
    const rows = parseNavHistoryJsonl(
      [line(2), line(0), line(1, { chainId: 46630, vaultKey: 'demo' }), line(1, { vaultKey: 'pons' }), line(1)].join('\n'),
    );
    expect(navHistoryFor(rows, 4663, 'main').map((p) => p.t)).toEqual([T0, T0 + HOUR, T0 + 2 * HOUR]);
    expect(navHistoryFor(rows, 46630, 'demo')).toHaveLength(1);
    expect(navHistoryFor(rows, 46630, 'pons')).toEqual([]);
  });
});

describe('useNavHistory', () => {
  it('no source URL → nothing fetched, not real', () => {
    const fetchFn = stubFetch(body(10));
    const { result } = renderHook(() => useNavHistory(4663, 'main', ''), { wrapper: wrapper() });
    expect(result.current).toEqual({ hasSource: false, points: [], isReal: false, isLoading: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('3 snapshots → points, but still illustrative', async () => {
    stubFetch(body(3));
    const { result } = renderHook(() => useNavHistory(4663, 'main', URL_), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.points).toHaveLength(3));
    expect(result.current.isReal).toBe(false);
  });

  it(`≥ ${MIN_NAV_HISTORY_POINTS} snapshots → the real series`, async () => {
    const fetchFn = stubFetch(body(MIN_NAV_HISTORY_POINTS));
    const { result } = renderHook(() => useNavHistory(4663, 'main', URL_), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isReal).toBe(true));
    expect(fetchFn).toHaveBeenCalledWith(URL_, expect.anything());
    expect(result.current.points).toHaveLength(MIN_NAV_HISTORY_POINTS);
  });

  it('another vault in the same file (the demo chain without rows) is not real', async () => {
    stubFetch(body(10));
    const { result } = renderHook(() => useNavHistory(46630, 'demo', URL_), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.points).toEqual([]);
    expect(result.current.isReal).toBe(false);
  });

  it('a failed fetch → not real (the chart falls back)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    const { result } = renderHook(() => useNavHistory(4663, 'main', URL_), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isReal).toBe(false);
  });
});

describe('NavChart — real series vs illustrative', () => {
  const W = wrapper();
  const renderChart = (historyUrl: string) =>
    render(<NavChart seed="4663-main" chainId={4663} vaultKey="main" symbol="sunEthLP" liveNav={1.2} historyUrl={historyUrl} />, { wrapper: W });

  it('no source → the illustrative line, unbadged for now', () => {
    renderChart('');
    expect(screen.queryByText('Illustrative')).toBeNull();
    expect(screen.queryByTestId('nav-history-until')).toBeNull();
  });

  it('3 snapshots → still the illustrative line', async () => {
    stubFetch(body(3));
    renderChart(URL_ + '?3');
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('Illustrative')).toBeNull();
    expect(screen.queryByTestId('nav-history-until')).toBeNull();
  });

  it('≥ 6 snapshots → the real line, no badge, a data-until stamp; the live readout is unchanged', async () => {
    stubFetch(body(8));
    renderChart(URL_ + '?8');
    const until = await screen.findByTestId('nav-history-until');
    expect(until.textContent).toBe('snapshots until Oct 18, 07:00 UTC');
    expect(screen.queryByText('Illustrative')).toBeNull();
    // Return over the drawn window: 1.107 / 1.1 − 1.
    expect(screen.getByText('+0.64%')).toBeDefined();
    expect(screen.getByTestId('nav-live').textContent).toContain('$1.20');
  });
});
