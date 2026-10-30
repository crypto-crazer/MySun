/**
 * Team mode — a hidden, client-side soft gate over the registry's `staging: true` vaults.
 *
 * The registry marks team-only vaults `staging` (shared/deployments.json → generated.ts). While the
 * gate is locked they are not shown AND not read: the app filters the vault list before any read is
 * built (src/chain/useVaultCatalog.ts), so a locked visitor issues no RPC call for them. Unlocking
 * takes an access code whose SHA-256 is baked into the build (`VITE_GOLDEN_FINGER_SHA256`); the
 * browser then keeps THE HASH THAT UNLOCKED (never the code) in localStorage, so a new access code
 * re-locks every browser on its own.
 *
 * This protects nothing — the vaults are public on-chain and in the bundle. It keeps staging content
 * out of the default view, that is all.
 *
 * Pure + injectable: `createTeamMode({ hash, storage })` is what the tests drive; the app uses the
 * singleton below, bound to `import.meta.env` and `localStorage`. Nothing here throws on a missing
 * env, a missing `localStorage` or one that throws (Safari private mode).
 */
import { useSyncExternalStore } from 'react';

/** localStorage key: holds the hash the browser unlocked with — not a boolean, never the code. */
export const TEAM_MODE_STORAGE_KEY = 'mysun.team-mode';

export type UnlockResult = 'ok' | 'bad' | 'unconfigured';

export interface TeamStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The env value → a lowercase 64-hex SHA-256, or undefined (missing, short, junk = unconfigured). */
export function parseTeamHash(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const hash = raw.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(hash) ? hash : undefined;
}

/* ---------- SHA-256 ---------- */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/**
 * Plain SHA-256 (FIPS 180-4), no dependencies — the fallback for a page without `crypto.subtle`,
 * which browsers leave undefined on a non-secure context (a phone on `http://192.168.x.x`).
 * Textbook public-domain construction; the published vectors are in src/test/teamMode.test.ts.
 */
export function sha256HexFallback(text: string): string {
  const bytes = new TextEncoder().encode(text);
  // Padding: 0x80, zeros to 56 mod 64, then the bit length as a 64-bit big-endian integer.
  const blocks = Math.ceil((bytes.length + 9) / 64);
  const buf = new Uint8Array(blocks * 64);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(buf.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(buf.length - 4, (bytes.length * 8) >>> 0);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}

/**
 * Lowercase hex SHA-256 of `text` (UTF-8): WebCrypto when the page has it, else the fallback above.
 * `subtle` is injectable for the tests (`null` forces the fallback).
 */
export async function sha256Hex(text: string, subtle: SubtleCrypto | null | undefined = globalThis.crypto?.subtle): Promise<string> {
  if (!subtle) return sha256HexFallback(text);
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- storage ---------- */

/** Same idea as the store's `memoryStorage`: what a node / storage-less page falls back to. */
export function memoryStorage(): TeamStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/**
 * `window.localStorage` specifically (a bare `localStorage` is not the browser's one under node —
 * see useTargetChain.tsx); none, or one whose access throws (blocked storage) → memory.
 */
function browserStorage(): TeamStorage {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    /* access itself can throw */
  }
  return memoryStorage();
}

/* ---------- the gate ---------- */

export interface TeamMode {
  isConfigured(): boolean;
  isUnlocked(): boolean;
  /** Trims the code, hashes it, compares. The code itself is never logged or stored. */
  unlock(code: string): Promise<UnlockResult>;
  lock(): void;
  /** Called on every lock / unlock — this tab's or (via the `storage` event) another tab's. */
  subscribe(cb: () => void): () => void;
  /** `staging: true` is visible only while unlocked; `unlocked` defaults to the current state. */
  isVaultVisible(entry: { readonly staging?: boolean }, unlocked?: boolean): boolean;
  visibleVaults<T extends { readonly staging?: boolean }>(list: readonly T[], unlocked?: boolean): T[];
}

export function createTeamMode({ hash, storage }: { hash: string | undefined; storage: TeamStorage }): TeamMode {
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((cb) => cb());
  // Set only when the storage refused the unlock write (Safari private mode): this tab then stays
  // unlocked in memory for the page's life instead of silently re-locking.
  let held: string | undefined;
  const stored = () => {
    try {
      return storage.getItem(TEAM_MODE_STORAGE_KEY);
    } catch {
      return null;
    }
  };
  const read = () => held ?? stored();
  const isConfigured = () => hash !== undefined;
  const isUnlocked = () => hash !== undefined && read() === hash;
  const isVaultVisible = (entry: { readonly staging?: boolean }, unlocked = isUnlocked()) => entry.staging !== true || unlocked;

  return {
    isConfigured,
    isUnlocked,
    async unlock(code) {
      if (hash === undefined) return 'unconfigured';
      if ((await sha256Hex(code.trim())) !== hash) return 'bad';
      try {
        storage.setItem(TEAM_MODE_STORAGE_KEY, hash);
      } catch {
        /* private mode: remembered in memory below, not across reloads */
      }
      if (stored() !== hash) held = hash;
      emit();
      return 'ok';
    },
    lock() {
      held = undefined;
      try {
        storage.removeItem(TEAM_MODE_STORAGE_KEY);
      } catch {
        /* nothing stored, nothing to remove */
      }
      emit();
    },
    subscribe(cb) {
      listeners.add(cb);
      // Another tab's lock / unlock arrives as a `storage` event; two tabs then agree.
      const onStorage = (e: StorageEvent) => {
        if (e.key === null || e.key === TEAM_MODE_STORAGE_KEY) cb();
      };
      if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(cb);
        if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
      };
    },
    isVaultVisible,
    visibleVaults: (list, unlocked = isUnlocked()) => list.filter((v) => isVaultVisible(v, unlocked)),
  };
}

/** The build's hash: `VITE_GOLDEN_FINGER_SHA256`, unset (vitest, local dev, tsx) = unconfigured. */
export const TEAM_HASH: string | undefined = parseTeamHash(import.meta.env?.VITE_GOLDEN_FINGER_SHA256);

/** The app's gate, bound to this build's hash and the browser's localStorage. */
export const teamMode: TeamMode = createTeamMode({ hash: TEAM_HASH, storage: browserStorage() });

/** Whether team mode is on, as React state — re-renders on lock / unlock in this tab or another. */
export function useTeamUnlocked(): boolean {
  return useSyncExternalStore(teamMode.subscribe, teamMode.isUnlocked, teamMode.isUnlocked);
}
