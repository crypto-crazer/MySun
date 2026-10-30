// @vitest-environment jsdom
/**
 * Team mode, rendered: the real Layout + Markets + vault page over the REAL catalogue
 * (useLiveVaults → useVaultCatalog → useReads), with the transport mocked at `readMany` (every call
 * recorded, every call failing — the rows then render from the registry alone) and `fetch` recording
 * whatever else would leave the page. This build is configured with a fixture hash, so the gate can
 * be opened with its code.
 *
 *  - locked: 4663 lists only its non-staging vaults, no STAGING chip, and NO read is addressed to a
 *    staging vault (nor does one appear in any request body);
 *  - a deep link / `?deposit=` to a staging vault lands on the unknown-vault state;
 *  - 6 taps, slow taps or a tap elsewhere do not open the panel; 7 quick taps do;
 *  - a wrong code keeps it locked; the right one unlocks without a reload — rows + chip appear — and
 *    "Leave team mode" hides them again; 5 failures pause submission;
 *  - unlocked, staging ROWS carry the preview mark (ui/Preview.tsx) — `data-preview="true"` and the
 *    sr-only "Not public yet" — while pages carry none (owner call: the chip is the page's only hint),
 *    and the word "Staging" appears nowhere but the header chip.
 *
 * Expectations come from the registry (`deploymentForChain(4663)` filtered by `staging`), never counts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ContractCall, ReadResult } from '@/chain/client';

const FIXTURE = vi.hoisted(() => {
  // sha256('open sesame') — asserted below against the module's own sha256Hex.
  const hash = '41ef4bb0b23661e66301aac36066912dac037827b4ae63a7b1165a5aa93ed4eb';
  vi.stubEnv('VITE_GOLDEN_FINGER_SHA256', hash);
  return { code: 'open sesame', hash };
});

const readMany = vi.hoisted(() => vi.fn<(chainId: number, calls: readonly ContractCall[]) => Promise<ReadResult[]>>());
vi.mock('@/chain/client', async (orig) => ({ ...(await orig<typeof import('@/chain/client')>()), readMany }));

/*
 * Test-environment shim (see picker.test): node's global `localStorage` shadows jsdom's. Installed
 * before the app modules load — the team-mode singleton binds `window.localStorage` at import.
 */
if (!window.localStorage) {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    } satisfies Storage,
  });
}

const { ChainProviders } = await import('@/chain/Providers');
const { deploymentForChain } = await import('@/chain/chains');
const { Layout } = await import('@/components/layout/Layout');
const { Markets } = await import('@/pages/Markets');
const { VaultDetail } = await import('@/pages/VaultDetail');
const { TEAM_TAPS, TEAM_TAP_GAP_MS, TEAM_MAX_FAILURES } = await import('@/components/layout/TeamMode');
const { TEAM_MODE_STORAGE_KEY, sha256Hex, teamMode } = await import('@/lib/teamMode');
const { PREVIEW_DIM, PREVIEW_RESTORE } = await import('@/components/ui/Preview');

const VAULTS = deploymentForChain(4663)!.vaults;
const STAGING = VAULTS.filter((v) => v.staging === true);
const PUBLIC = VAULTS.filter((v) => v.staging !== true);
const ids = (list: readonly { key: string }[]) => list.map((v) => `4663-${v.key}`).sort();
const STAGING_ADDRS = STAGING.map((v) => v.vault.toLowerCase());

/** Every contract address a `readMany` call was asked about, lowercase. */
let readAddrs: string[] = [];
/** Every body `fetch` was handed (anything that bypassed readMany). */
let fetchBodies: string[] = [];

beforeEach(() => {
  teamMode.lock();
  window.localStorage.clear();
  readAddrs = [];
  fetchBodies = [];
  readMany.mockReset();
  readMany.mockImplementation(async (_chainId, calls) => {
    for (const c of calls) readAddrs.push(c.address.toLowerCase());
    throw new Error('test transport: no chain');
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    fetchBodies.push(String(init?.body ?? ''));
    throw new Error('test transport: no network');
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  teamMode.lock();
});

function renderAt(path: string) {
  return render(
    <ChainProviders>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Markets />} />
            <Route path="/vault/:id" element={<VaultDetail />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ChainProviders>,
  );
}

const rowIds = (c: HTMLElement) => [...c.querySelectorAll('li[data-vault]')].map((r) => r.getAttribute('data-vault')!).sort();
const tapTarget = (c: HTMLElement) => c.ownerDocument.querySelector('[data-team-tap]') as HTMLElement;
const tap = (el: HTMLElement, n: number) => {
  for (let i = 0; i < n; i++) fireEvent.click(el);
};
const panel = () => screen.queryByRole('dialog');
const chip = () => screen.queryByRole('button', { name: 'Staging' });
/** The page body: everything but the header, whose chip is the one place the word may appear. */
const main = () => screen.getByRole('main');
const marked = (c: HTMLElement) => [...c.querySelectorAll('[data-preview="true"]')];

/** No read and no request body named a staging vault. */
function expectNoStagingReads() {
  expect(readAddrs.length).toBeGreaterThan(0); // the catalogue did read — just not those
  for (const a of STAGING_ADDRS) {
    expect(readAddrs, a).not.toContain(a);
    for (const b of fetchBodies) expect(b.toLowerCase()).not.toContain(a.slice(2));
  }
}

async function submitCode(code: string) {
  const input = screen.getByLabelText('Access code') as HTMLInputElement;
  fireEvent.change(input, { target: { value: code } });
  const form = input.closest('form')!;
  await act(async () => {
    fireEvent.submit(form);
  });
  // WebCrypto answers off the microtask queue: wait for this attempt to settle before the next one.
  await waitFor(() => expect(screen.queryByRole('dialog')?.querySelector('form[aria-busy="true"]') ?? null).toBeNull());
  return input;
}

describe('the fixture build', () => {
  it('is configured with the hash of the fixture code', async () => {
    expect(await sha256Hex(FIXTURE.code)).toBe(FIXTURE.hash);
    expect(teamMode.isConfigured()).toBe(true);
    expect(teamMode.isUnlocked()).toBe(false);
    expect(STAGING.length).toBeGreaterThan(0);
    expect(PUBLIC.length).toBeGreaterThan(0);
  });
});

describe('locked (the default)', () => {
  it('Markets on 4663 lists only the non-staging vaults — no chip, no preview mark — and reads none of the staging vaults', async () => {
    const { container } = renderAt('/');
    await waitFor(() => expect(readMany).toHaveBeenCalled());
    expect(rowIds(container)).toEqual(ids(PUBLIC));
    expect(chip()).toBeNull();
    expect(screen.queryByText(/^Staging$/i)).toBeNull();
    expect(marked(container)).toEqual([]);
    expect(screen.queryByText('Not public yet')).toBeNull();
    // let the follow-up rounds and the spot hooks settle too
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expectNoStagingReads();
  });

  it('a deep link to a staging vault never resolves to it — full id and classic id alike', async () => {
    // The full id names this chain, so a hidden vault has nothing to show.
    renderAt(`/vault/4663-${STAGING[0].key}`);
    expect(await screen.findByText(/Vault not found/)).toBeDefined();
    cleanup();
    // The classic id resolves only when exactly ONE chain lists the key: pick a staging key unique to
    // 4663. (A key another chain also lists — the local stack's own "tri" — resolves to that chain's
    // vault instead in this build; the reads below still prove 4663's copy was never involved.)
    const unique = STAGING.find((v) => !deploymentForChain(46630)?.vaults.some((o) => o.key === v.key));
    expect(unique).toBeDefined();
    renderAt(`/vault/${unique!.key}`);
    expect(await screen.findByText(/Vault not found/)).toBeDefined();
    cleanup();
    // The shared key: whichever way it resolves, it is never this chain's hidden vault.
    renderAt(`/vault/${STAGING[0].key}`);
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expectNoStagingReads();
  });

  it('?deposit= naming a staging vault opens no card', async () => {
    renderAt(`/?deposit=4663-${STAGING[0].key}`);
    await waitFor(() => expect(readMany).toHaveBeenCalled());
    expect(panel()).toBeNull();
    expectNoStagingReads();
  });
});

describe('the 7-tap entry', () => {
  it('the tap target is the footer brand name, out of the a11y tree, with no affordance', () => {
    const { container } = renderAt('/');
    const t = tapTarget(container);
    expect(t.closest('footer')).not.toBeNull();
    expect(t.getAttribute('aria-hidden')).toBe('true');
    expect(t.className).toMatch(/cursor-default/);
    expect(t.className).toMatch(/touch-action:manipulation/);
    expect(t.tabIndex).toBe(-1);
  });

  it(`${TEAM_TAPS - 1} taps do not open the panel; the ${TEAM_TAPS}th does`, () => {
    const { container } = renderAt('/');
    tap(tapTarget(container), TEAM_TAPS - 1);
    expect(panel()).toBeNull();
    tap(tapTarget(container), 1);
    expect(within(panel()!).getByText('Team mode')).toBeDefined();
  });

  it('a slow tap (> the gap) starts the count over', () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { container } = renderAt('/');
    const t = tapTarget(container);
    tap(t, TEAM_TAPS - 1);
    now += TEAM_TAP_GAP_MS + 1;
    tap(t, 1); // slow: this is tap 1 of a new count
    expect(panel()).toBeNull();
    tap(t, TEAM_TAPS - 2);
    expect(panel()).toBeNull();
    tap(t, 1);
    expect(panel()).not.toBeNull();
  });

  it('a tap on another element resets the count', () => {
    const { container } = renderAt('/');
    const t = tapTarget(container);
    tap(t, TEAM_TAPS - 1);
    fireEvent.click(screen.getByRole('heading', { name: 'Vaults' }));
    tap(t, 1);
    expect(panel()).toBeNull();
  });
});

describe('unlocking', () => {
  it('a wrong code keeps it locked; the right one unlocks without a reload; leaving hides the rows again', async () => {
    const { container } = renderAt('/');
    tap(tapTarget(container), TEAM_TAPS);
    const input = await submitCode('not the code');
    expect(screen.getByRole('alert').textContent).toMatch(/didn't work/);
    expect(input.value).toBe(''); // never kept or echoed
    expect(teamMode.isUnlocked()).toBe(false);
    expect(rowIds(container)).toEqual(ids(PUBLIC));
    expect(window.localStorage.getItem(TEAM_MODE_STORAGE_KEY)).toBeNull();

    await submitCode(FIXTURE.code);
    await waitFor(() => expect(panel()).toBeNull());
    expect(teamMode.isUnlocked()).toBe(true);
    expect(window.localStorage.getItem(TEAM_MODE_STORAGE_KEY)).toBe(FIXTURE.hash);
    // the same mount: every vault now, the chip, and the preview mark on exactly the staging rows
    await waitFor(() => expect(rowIds(container)).toEqual(ids(VAULTS)));
    expect(chip()).not.toBeNull();
    expect(marked(container).map((el) => el.getAttribute('data-vault')).sort()).toEqual(ids(STAGING));
    for (const v of STAGING) {
      const row = container.querySelector(`li[data-vault="4663-${v.key}"]`) as HTMLElement;
      const sr = within(row).getByText('Not public yet');
      expect(sr.className).toContain('sr-only');
    }
    for (const v of PUBLIC) {
      const row = container.querySelector(`li[data-vault="4663-${v.key}"]`) as HTMLElement;
      expect(row.hasAttribute('data-preview')).toBe(false);
      expect(within(row).queryByText('Not public yet')).toBeNull();
    }
    // no word on the content: the chip (a button in the header) is the only "Staging" on screen
    expect(within(main()).queryByText(/^Staging$/i)).toBeNull();
    expect(screen.getAllByText(/^Staging$/i)).toEqual([chip()]);
    // …and now the staging vaults are read (the one refetch an unlock costs)
    await waitFor(() => expect(readAddrs).toContain(STAGING_ADDRS[0]));

    // The chip opens the same panel, which offers to leave
    fireEvent.click(chip()!);
    expect(within(panel()!).getByText(/Team mode is on — staging content is visible/)).toBeDefined();
    fireEvent.click(within(panel()!).getByRole('button', { name: 'Leave team mode' }));
    await waitFor(() => expect(rowIds(container)).toEqual(ids(PUBLIC)));
    expect(chip()).toBeNull();
    expect(teamMode.isUnlocked()).toBe(false);
  });

  it('unlocked, the staging vault page renders plainly — the header chip is its only hint, and no "Staging" word', async () => {
    await teamMode.unlock(FIXTURE.code);
    const { container } = renderAt(`/vault/4663-${STAGING[0].key}`);
    expect(screen.queryByText(/Vault not found/)).toBeNull();
    // No region treatment on a page: the mark belongs to rows (owner call — the page-header edge read
    // as special treatment). The chip above is what says team mode is on.
    expect(marked(container)).toEqual([]);
    expect(screen.queryByText('Not public yet')).toBeNull();
    expect(within(main()).queryByText(/^Staging$/i)).toBeNull();
  });

  it('a public vault page carries no preview mark, unlocked or not', async () => {
    await teamMode.unlock(FIXTURE.code);
    const { container } = renderAt(`/vault/4663-${PUBLIC[0].key}`);
    expect(screen.queryByText(/Vault not found/)).toBeNull();
    expect(marked(container)).toEqual([]);
    expect(screen.queryByText('Not public yet')).toBeNull();
  });

  it('a marked row keeps the same emphasis classes as a public row — the dim and its hover restore live on the row', async () => {
    // jsdom computes no styles, so hover / focus-within cannot be observed as colour here. What can be
    // asserted: every cell, the name and the Deposit button carry the same classes in both rows (the
    // dim is the row's own PREVIEW_DIM, lifted by its PREVIEW_RESTORE; preview.test.tsx compiles both
    // and checks the selectors), and hovering / focusing the row changes no class at all.
    await teamMode.unlock(FIXTURE.code);
    const { container } = renderAt('/');
    await waitFor(() => expect(rowIds(container)).toEqual(ids(VAULTS)));
    const rowOf = (key: string) => container.querySelector(`li[data-vault="4663-${key}"]`) as HTMLElement;
    const shape = (row: HTMLElement) => ({
      cells: [...row.children].filter((el) => el.matches('div')).map((el) => el.className),
      name: row.querySelector('[data-preview-keep]')!.className,
      button: within(row).getByRole('button').className,
    });
    const pub = rowOf(PUBLIC[0].key);
    const stg = rowOf(STAGING[0].key);
    expect(shape(stg)).toEqual(shape(pub));
    expect(stg.className).toContain(PREVIEW_DIM);
    expect(stg.className).toContain(PREVIEW_RESTORE);
    expect(pub.className).not.toContain(PREVIEW_DIM);
    const before = shape(stg);
    fireEvent.mouseOver(stg);
    fireEvent.focus(stg);
    expect(shape(stg)).toEqual(before);
  });

  it(`${TEAM_MAX_FAILURES} failed attempts pause submission`, async () => {
    const { container } = renderAt('/');
    tap(tapTarget(container), TEAM_TAPS);
    for (let i = 0; i < TEAM_MAX_FAILURES; i++) await submitCode(`wrong ${i}`);
    const input = screen.getByLabelText('Access code') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toMatch(/Too many attempts/);
    // the right code cannot get through while paused
    await submitCode(FIXTURE.code);
    expect(teamMode.isUnlocked()).toBe(false);
    expect((screen.getByRole('button', { name: 'Unlock' }) as HTMLButtonElement).disabled).toBe(true);
    // closing and reopening the panel does not lift the pause
    fireEvent.keyDown(window, { key: 'Escape' });
    tap(tapTarget(container), TEAM_TAPS);
    expect((screen.getByLabelText('Access code') as HTMLInputElement).disabled).toBe(true);
  });

  it('an unconfigured build: the panel says so and the input is disabled', async () => {
    vi.spyOn(teamMode, 'isConfigured').mockReturnValue(false);
    const { container } = renderAt('/');
    tap(tapTarget(container), TEAM_TAPS);
    expect(screen.getByText("Team mode isn't configured in this build.")).toBeDefined();
    expect((screen.getByLabelText('Access code') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Unlock' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Escape closes the panel', () => {
    const { container } = renderAt('/');
    tap(tapTarget(container), TEAM_TAPS);
    expect(panel()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(panel()).toBeNull();
  });
});
