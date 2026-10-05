/**
 * The target chain and vault, in React: the selected chain and the per-chain vault choice live here
 * (app-wide state), the wallet's chain comes from the wallet layer, and `resolveTargetChain` decides.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useWallet } from '@/wallet/context';
import { DEFAULT_CHAIN_ID } from './chains';
import { resolveTargetChain, type TargetChain } from './targetChain';
import { VAULT_SELECTION_KEY, parseVaultSelection, selectVault, type VaultSelection } from './vaultSelection';

interface Selection {
  selectedChainId: number;
  setSelectedChainId: (chainId: number) => void;
  selectedVaults: VaultSelection;
  setSelectedVault: (chainId: number, key: string) => void;
}

const SelectionContext = createContext<Selection | null>(null);

/** `window.localStorage` specifically: a bare `localStorage` is not the browser's one under node. */
function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined; // private mode / blocked storage
  }
}

function readVaultSelection(): VaultSelection {
  try {
    return parseVaultSelection(storage()?.getItem(VAULT_SELECTION_KEY));
  } catch {
    return {};
  }
}

function writeVaultSelection(selection: VaultSelection): void {
  try {
    storage()?.setItem(VAULT_SELECTION_KEY, JSON.stringify(selection));
  } catch {
    /* private mode — the choice just is not remembered across reloads */
  }
}

/**
 * Mount inside WalletProvider. Starts on DEFAULT_CHAIN_ID (the local stack when there is one) and on
 * the vault choices remembered in localStorage (none → every chain on its first vault).
 */
export function TargetChainProvider({ children }: { children: ReactNode }) {
  const [selectedChainId, setSelectedChainId] = useState(DEFAULT_CHAIN_ID);
  const [selectedVaults, setSelectedVaults] = useState<VaultSelection>(readVaultSelection);
  const setSelectedVault = useCallback((chainId: number, key: string) => {
    setSelectedVaults((prev) => selectVault(prev, chainId, key));
  }, []);
  useEffect(() => writeVaultSelection(selectedVaults), [selectedVaults]);
  const value = useMemo(
    () => ({ selectedChainId, setSelectedChainId, selectedVaults, setSelectedVault }),
    [selectedChainId, selectedVaults, setSelectedVault],
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

function useSelection(): Selection {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error('useTargetChain must be used inside <ChainProviders>.');
  return ctx;
}

/** `{ chain, deployment, vault, hasDeployment, isWrongChain }` for the live pages. Safe without a wallet. */
export function useTargetChain(): TargetChain & { selectedChainId: number } {
  const { address, chainId } = useWallet();
  const { selectedChainId, selectedVaults } = useSelection();
  // A wallet that is still connecting has no account yet: treat it as "no wallet".
  const walletChainId = address ? chainId : undefined;
  return useMemo(
    () => ({ ...resolveTargetChain({ walletChainId, selectedChainId, selectedVaults }), selectedChainId }),
    [walletChainId, selectedChainId, selectedVaults],
  );
}

/** Pick a vault on the target chain (remembered per chain). An unknown key is ignored. */
export function useSelectVault(): (key: string) => void {
  const { chain } = useTargetChain();
  const { setSelectedVault } = useSelection();
  return useCallback((key: string) => setSelectedVault(chain.id, key), [chain.id, setSelectedVault]);
}

/**
 * The one "go to chain X" action for the selector and the wrong-network buttons: it records the
 * choice (so read-only visitors switch what they are looking at) and, with a wallet connected,
 * asks the wallet to switch — adding the chain first when the wallet does not know it.
 */
export function useSwitchToChain() {
  const { address, switchChain, switching, error } = useWallet();
  const { setSelectedChainId } = useSelection();
  const switchTo = useCallback(
    async (chainId: number) => {
      setSelectedChainId(chainId);
      if (address) await switchChain(chainId);
    },
    [address, setSelectedChainId, switchChain],
  );
  return { switchTo, switching, error };
}
