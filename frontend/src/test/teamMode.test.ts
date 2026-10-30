/**
 * Team mode's gate (src/lib/teamMode.ts), pure: SHA-256 on both paths (WebCrypto and the vendored
 * fallback) against the published vectors, the env parse, unlock / lock / persistence / re-lock on a
 * changed hash, storage that throws, and the visibility filter over the real registry. The UI and the
 * "no read while locked" rule: teamgate.test.tsx.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { deploymentForChain } from '@/chain/chains';
import {
  TEAM_HASH,
  TEAM_MODE_STORAGE_KEY,
  createTeamMode,
  memoryStorage,
  parseTeamHash,
  sha256Hex,
  sha256HexFallback,
  teamMode,
  type TeamStorage,
} from '@/lib/teamMode';

const nodeSha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** FIPS 180-4 / NIST examples. */
const VECTORS: [string, string][] = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
];

const CODE = 'open sesame';
const HASH = nodeSha(CODE);
const OTHER_HASH = nodeSha('another code');

const REG_4663 = deploymentForChain(4663)!.vaults;
const STAGING = REG_4663.filter((v) => v.staging === true);
const PUBLIC = REG_4663.filter((v) => v.staging !== true);

describe('sha256Hex — both paths pass the published vectors', () => {
  it.each(VECTORS)('fallback: sha256(%j)', (input, hex) => {
    expect(sha256HexFallback(input)).toBe(hex);
  });

  it.each(VECTORS)('WebCrypto: sha256(%j)', async (input, hex) => {
    expect(globalThis.crypto?.subtle).toBeDefined();
    expect(await sha256Hex(input)).toBe(hex);
  });

  it('null subtle (a non-secure http page) takes the fallback, with the same answers', async () => {
    for (const [input, hex] of VECTORS) expect(await sha256Hex(input, null)).toBe(hex);
  });

  it('the fallback agrees with node on block boundaries, multi-block and UTF-8 input', () => {
    for (const n of [55, 56, 63, 64, 65, 119, 120, 1000]) expect(sha256HexFallback('a'.repeat(n)), `n=${n}`).toBe(nodeSha('a'.repeat(n)));
    for (const s of ['金手指', 'café ☕', '🌅 MySun']) expect(sha256HexFallback(s)).toBe(nodeSha(s));
  });
});

describe('parseTeamHash — anything but 64 hex is "unconfigured"', () => {
  it('trims and lowercases a valid hash', () => {
    expect(parseTeamHash(`  ${HASH.toUpperCase()}\n`)).toBe(HASH);
  });
  it.each([undefined, null, '', 'abc', HASH.slice(1), `${HASH}0`, `${HASH.slice(0, 63)}g`, 42])('rejects %j', (raw) => {
    expect(parseTeamHash(raw)).toBeUndefined();
  });
  it('this suite runs unconfigured (setup.ts pins the env): the app singleton is locked and never throws', async () => {
    expect(TEAM_HASH).toBeUndefined();
    expect(teamMode.isConfigured()).toBe(false);
    expect(teamMode.isUnlocked()).toBe(false);
    expect(await teamMode.unlock(CODE)).toBe('unconfigured');
  });
});

describe('createTeamMode — unlock / lock / persistence', () => {
  it('unconfigured: unlock answers "unconfigured" and stores nothing', async () => {
    const storage = memoryStorage();
    const gate = createTeamMode({ hash: undefined, storage });
    expect(gate.isConfigured()).toBe(false);
    expect(await gate.unlock(CODE)).toBe('unconfigured');
    expect(gate.isUnlocked()).toBe(false);
    expect(storage.getItem(TEAM_MODE_STORAGE_KEY)).toBeNull();
  });

  it('a wrong code is "bad" and stays locked; the right one (input trimmed) is "ok"', async () => {
    const storage = memoryStorage();
    const gate = createTeamMode({ hash: HASH, storage });
    expect(gate.isConfigured()).toBe(true);
    expect(await gate.unlock('open sesame!')).toBe('bad');
    expect(gate.isUnlocked()).toBe(false);
    expect(storage.getItem(TEAM_MODE_STORAGE_KEY)).toBeNull();
    expect(await gate.unlock(`  ${CODE}\t`)).toBe('ok');
    expect(gate.isUnlocked()).toBe(true);
  });

  it('storage holds the hash that unlocked — never the code — and a reload (new instance) stays unlocked', async () => {
    const storage = memoryStorage();
    await createTeamMode({ hash: HASH, storage }).unlock(CODE);
    expect(storage.getItem(TEAM_MODE_STORAGE_KEY)).toBe(HASH);
    expect(storage.getItem(TEAM_MODE_STORAGE_KEY)).not.toContain(CODE);
    expect(createTeamMode({ hash: HASH, storage }).isUnlocked()).toBe(true);
  });

  it('a new access code (a build with another hash) re-locks a browser unlocked with the old one', async () => {
    const storage = memoryStorage();
    await createTeamMode({ hash: HASH, storage }).unlock(CODE);
    expect(createTeamMode({ hash: OTHER_HASH, storage }).isUnlocked()).toBe(false);
    expect(createTeamMode({ hash: undefined, storage }).isUnlocked()).toBe(false);
  });

  it('lock() clears it; subscribers hear every lock and unlock', async () => {
    const storage = memoryStorage();
    const gate = createTeamMode({ hash: HASH, storage });
    const cb = vi.fn();
    const off = gate.subscribe(cb);
    await gate.unlock(CODE);
    gate.lock();
    expect(cb).toHaveBeenCalledTimes(2);
    expect(gate.isUnlocked()).toBe(false);
    expect(storage.getItem(TEAM_MODE_STORAGE_KEY)).toBeNull();
    off();
    await gate.unlock(CODE);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('storage that throws (Safari private mode): never throws; unlock still holds for this page, lock releases it', async () => {
    const boom = () => {
      throw new Error('QuotaExceededError');
    };
    const storage: TeamStorage = { getItem: boom, setItem: boom, removeItem: boom };
    const gate = createTeamMode({ hash: HASH, storage });
    expect(gate.isUnlocked()).toBe(false);
    expect(await gate.unlock(CODE)).toBe('ok');
    expect(gate.isUnlocked()).toBe(true);
    expect(() => gate.lock()).not.toThrow();
    expect(gate.isUnlocked()).toBe(false);
  });

  it('a hand-edited storage value (e.g. "true") does not unlock', () => {
    const storage = memoryStorage();
    storage.setItem(TEAM_MODE_STORAGE_KEY, 'true');
    expect(createTeamMode({ hash: HASH, storage }).isUnlocked()).toBe(false);
  });
});

describe('visibility over the real registry (4663)', () => {
  it('the registry marks some 4663 vaults staging and leaves others public', () => {
    expect(STAGING.length).toBeGreaterThan(0);
    expect(PUBLIC.length).toBeGreaterThan(0);
  });

  it('locked: staging vaults are hidden; unlocked: every vault, in registry order', async () => {
    const gate = createTeamMode({ hash: HASH, storage: memoryStorage() });
    expect(gate.visibleVaults(REG_4663).map((v) => v.key)).toEqual(PUBLIC.map((v) => v.key));
    for (const v of STAGING) expect(gate.isVaultVisible(v)).toBe(false);
    await gate.unlock(CODE);
    expect(gate.visibleVaults(REG_4663)).toEqual([...REG_4663]);
    for (const v of STAGING) expect(gate.isVaultVisible(v)).toBe(true);
    // an explicit state wins over the stored one (React passes its own snapshot)
    expect(gate.visibleVaults(REG_4663, false).map((v) => v.key)).toEqual(PUBLIC.map((v) => v.key));
  });
});

// "A remembered staging vault falls back under the gate" (resolveVault) is gone with the per-chain
// vault selection it guarded: no vault choice is stored any more, so none can leak. The rules that
// still keep a staging vault hidden while locked — the Markets rows, deep links, `?deposit=` — are
// asserted in teamgate.test.tsx ("locked (the default)").
