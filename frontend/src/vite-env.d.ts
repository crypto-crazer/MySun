/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * WalletConnect (Reown) project id — user-supplied, never committed. Get a free one at
   * https://cloud.reown.com and put it in `frontend/.env.local`. Unset ⇒ the WalletConnect entry
   * is hidden from the picker; injected wallets are unaffected.
   */
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  /**
   * The NAV-history collector's JSONL (`…/analytics/nav-history.jsonl`). Unset ⇒ the vault page's
   * price chart keeps its illustrative line (badged).
   */
  readonly VITE_NAV_HISTORY_URL?: string;
  /**
   * SHA-256 (64 hex) of the team access code — unlocks team mode (the registry's `staging` vaults;
   * src/lib/teamMode.ts). Unset or malformed ⇒ team mode is off. Never commit a real hash.
   */
  readonly VITE_GOLDEN_FINGER_SHA256?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
