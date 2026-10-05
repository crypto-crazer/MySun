/**
 * Which vault the live pages show on a chain — a pure function of the registry and the user's
 * remembered choice, so the rule is testable without React or a browser:
 *
 *   the key selected FOR THAT CHAIN, when it still names a vault there → that vault;
 *   otherwise (nothing selected, a stale key, garbage in storage)     → the chain's first vault.
 *
 * A chain without a deployment has no vault at all (undefined). The choice is remembered per chain,
 * so picking "stocks" on one chain never changes what another chain shows, and a key that vanishes
 * from the registry after a redeploy just falls back — it never crashes the page.
 */
import { defaultVault, findVault, type VaultEntry } from './chains';

/** Same slug rule scripts/registry.ts enforces on `vaults[].key`. */
const VAULT_KEY_RE = /^[a-z][a-z0-9-]*$/;

/** Decimal chain id → selected vault key. */
export type VaultSelection = Readonly<Record<string, string>>;

/** localStorage key. Only chain ids and vault slugs — nothing about the user. */
export const VAULT_SELECTION_KEY = 'mysun.vault.selected';

export function resolveVault(chainId: number | undefined, selection: VaultSelection | undefined): VaultEntry | undefined {
  if (chainId === undefined) return undefined;
  return findVault(chainId, selection?.[String(chainId)]) ?? defaultVault(chainId);
}

/**
 * Record `key` as the choice for `chainId`. A key that names no vault on that chain is ignored
 * (selection returned unchanged), so the stored state only ever holds choices that were valid.
 */
export function selectVault(selection: VaultSelection, chainId: number, key: string): VaultSelection {
  if (!findVault(chainId, key) || selection[String(chainId)] === key) return selection;
  return { ...selection, [String(chainId)]: key };
}

/**
 * Stored text → a selection, dropping anything that is not `"<chain id>": "<slug>"`. Never throws:
 * storage is user-editable and may hold anything, including a previous version's shape.
 */
export function parseVaultSelection(raw: string | null | undefined): VaultSelection {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [chainId, key] of Object.entries(parsed)) {
    if (/^[1-9]\d*$/.test(chainId) && typeof key === 'string' && VAULT_KEY_RE.test(key)) out[chainId] = key;
  }
  return out;
}
