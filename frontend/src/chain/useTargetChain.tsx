/**
 * The target chain, in React: the selected chain lives here (app-wide state), the wallet's chain comes
 * from the wallet layer, and `resolveTargetChain` decides.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useWallet } from '@/wallet/context';
import { DEFAULT_CHAIN_ID } from './chains';
import { resolveTargetChain, type TargetChain } from './targetChain';

interface Selection {
  selectedChainId: number;
  setSelectedChainId: (chainId: number) => void;
}

const SelectionContext = createContext<Selection | null>(null);

/**
 * Mount inside WalletProvider. Starts on DEFAULT_CHAIN_ID (the first live deployment; never the local stack while one exists).
 */
export function TargetChainProvider({ children, initialChainId }: { children: ReactNode; initialChainId?: number }) {
  const [selectedChainId, setSelectedChainId] = useState(initialChainId ?? DEFAULT_CHAIN_ID);
  const value = useMemo(() => ({ selectedChainId, setSelectedChainId }), [selectedChainId]);
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

function useSelection(): Selection {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error('useTargetChain must be used inside <ChainProviders>.');
  return ctx;
}

/** `{ chain, deployment, hasDeployment, isWrongChain }` for the live pages. Safe without a wallet. */
export function useTargetChain(): TargetChain & { selectedChainId: number } {
  const { address, chainId } = useWallet();
  const { selectedChainId } = useSelection();
  // A wallet that is still connecting has no account yet: treat it as "no wallet".
  const walletChainId = address ? chainId : undefined;
  return useMemo(
    () => ({ ...resolveTargetChain({ walletChainId, selectedChainId }), selectedChainId }),
    [walletChainId, selectedChainId],
  );
}

/**
 * Look at a vault: select its chain — no wallet prompt (the vault page shows the wrong-network
 * banner if the wallet is elsewhere). The vault page calls it; the vault itself is the page's URL.
 */
export function useOpenVault(): (chainId: number) => void {
  const { setSelectedChainId } = useSelection();
  return setSelectedChainId;
}

/**
 * The one "go to chain X" action for the selector and the wrong-network buttons: it records the
 * choice (so visitors with no wallet switch what they are looking at) and, with a wallet connected,
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
