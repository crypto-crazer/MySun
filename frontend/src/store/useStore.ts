import { create } from 'zustand';

export interface Toast {
  id: string;
  title: string;
  detail?: string;
  tone?: 'default' | 'accent' | 'success' | 'warning';
}

interface AppState {
  /** A real wallet account is connected. Mirrored from src/wallet by `useWalletBridge`. */
  connected: boolean;
  /** That account, or null with no wallet connected. */
  address: string | null;
  toasts: Toast[];

  /** Bridge from src/wallet: a real wallet connected (address) or went away (null). */
  setWallet: (address: string | null) => void;
  pushToast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
}

const uid = () => Math.random().toString(36).slice(2, 10);

// One-time cleanup: the retired prototype store persisted under these keys — a fabricated demo
// portfolio seeded on wallet connect, and a remembered vault choice. Clear what they already wrote
// into visitors' browsers.
if (typeof localStorage !== 'undefined') {
  localStorage.removeItem('mysun-demo-v1');
  localStorage.removeItem('mysun.vault.selected');
}

export const useStore = create<AppState>()((set, get) => ({
  connected: false,
  address: null,
  toasts: [],

  setWallet: (address) => set({ address, connected: address !== null }),

  pushToast: (t) => {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => get().dismissToast(id), 4200);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
