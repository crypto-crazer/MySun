/**
 * One connect entry point for the whole app.
 *
 * "Connect" means "open the wallet picker": the browser may have MetaMask, Rabby, Coinbase,
 * Brave, Phantom … announced over EIP-6963, plus WalletConnect for phones, and the visitor picks.
 * No wallet is needed to read: every figure comes from the chain without one; a wallet is needed
 * to deposit or withdraw.
 */
import { useEffect } from 'react';
import { useWallet } from '@/wallet/context';
import { useStore } from '@/store/useStore';

export function useConnectWallet() {
  const { status, openPicker, error } = useWallet();

  return {
    isPending: status === 'connecting',
    error,
    connectWallet: () => openPicker(),
  };
}

/** Mirrors the connected account into the store (the hero's connect gate reads it). Mount once, inside the providers. */
export function useWalletBridge(): void {
  const { address, status } = useWallet();
  const setWallet = useStore((s) => s.setWallet);
  useEffect(() => {
    if (status === 'connecting') return;
    setWallet(status === 'connected' && address ? address : null);
  }, [address, status, setWallet]);
}

/** Disconnects the wallet; the bridge then clears the store's mirror. */
export function useDisconnectWallet() {
  const { disconnect } = useWallet();
  return () => {
    void disconnect();
  };
}
