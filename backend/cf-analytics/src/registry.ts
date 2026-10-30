/**
 * Registry reader for the Worker: `shared/deployments.json`, bundled at build time (no fs, no local
 * overlay — `deployment.local.json` describes a stack on someone's Mac and is never shipped).
 *
 * Validation is the keeper's `buildRegistry` (backend/src/registry.ts, imported read-only) — the
 * same single source of truth the Railway collector uses.
 *
 * One adaptation: the registry may mark a chain `deployed` without a `vaults` list when the vaults
 * live only in the local overlay (today: the demo chain). `buildRegistry` rejects that without the
 * overlay, which would fail every cron. Such entries carry nothing to collect — `collectOnce` drops
 * chains with no vaults anyway — so they are removed BEFORE validation, by shape, not by chain id.
 */

import deployments from '../../../shared/deployments.json';
import { buildRegistry, type RegistryChain } from '../../src/registry.js';

export type { DeployedChain, RegistryChain } from '../../src/registry.js';

/** Drop `deployed` chain entries that list no vaults (overlay-only chains); everything else verbatim. */
export function withoutOverlayOnlyChains(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const root = raw as Record<string, unknown>;
  const chains = root.chains;
  if (typeof chains !== 'object' || chains === null || Array.isArray(chains)) return raw;
  const kept = Object.fromEntries(
    Object.entries(chains as Record<string, unknown>).filter(([, entry]) => {
      const e = entry as Record<string, unknown> | null;
      return !(typeof e === 'object' && e !== null && e.status === 'deployed' && e.vaults === undefined);
    }),
  );
  return { ...root, chains: kept };
}

/** The validated chain list from a registry object (default: the bundled deployments.json). */
export function loadChains(raw: unknown = deployments): RegistryChain[] {
  return buildRegistry({ registryText: JSON.stringify(withoutOverlayOnlyChains(raw)) });
}
