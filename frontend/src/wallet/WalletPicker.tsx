/**
 * The wallet picker: every wallet this browser can actually reach, in one modal.
 *
 * Names and icons are whatever the wallet announced over EIP-6963 — nothing here is a hardcoded
 * list of "supported" wallets, which is the point of the rework. WalletConnect appears only when a
 * project id is configured. No wallet is needed to browse: every figure is read from the chain
 * without one; a wallet is needed to deposit or withdraw.
 */
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import { useWallet } from './context';
import type { WalletOption } from './types';

export function WalletPicker() {
  const { pickerOpen, closePicker, options, connect, status, error, pendingId } = useWallet();
  const connecting = status === 'connecting';

  return (
    <Modal open={pickerOpen} onClose={closePicker} title="Connect a wallet">
      {options.length === 0 ? (
        <p className="text-weak leading-snug">
          No browser wallet detected. Install MetaMask, Rabby, Coinbase Wallet or any other EIP-6963
          wallet to deposit — every vault can be browsed without one.
        </p>
      ) : (
        <ul className="space-y-2">
          {options.map((o) => (
            <li key={o.id}>
              <WalletRow
                option={o}
                busy={connecting && pendingId === o.id}
                disabled={connecting}
                onClick={() => void connect(o)}
              />
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="mt-3 rounded border border-stroke-error/40 bg-fill-error/10 px-3 py-2 text-xs text-error leading-snug">
          {error.message}
        </p>
      )}

      <WalletConnectHint />
    </Modal>
  );
}

function WalletRow({
  option,
  busy,
  disabled,
  onClick,
}: {
  option: WalletOption;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full h-12 px-3 rounded-md border border-stroke-weak bg-fill-recessed hover:border-stroke-stronger disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center gap-3 text-left"
    >
      <WalletIcon option={option} />
      <span className="flex-1 min-w-0 text-base font-medium text-strong truncate">{option.name}</span>
      {busy ? (
        <Spinner className="h-4 w-4 text-weaker" />
      ) : (
        <span className="text-2xs text-weaker">
          {option.kind === 'walletconnect' ? 'QR / mobile' : 'Browser'}
        </span>
      )}
    </button>
  );
}

function WalletIcon({ option }: { option: WalletOption }) {
  if (option.icon) {
    return (
      <img
        src={option.icon}
        alt=""
        className="h-7 w-7 rounded-md shrink-0 bg-fill-weak object-contain"
        draggable={false}
      />
    );
  }
  return (
    <span className="h-7 w-7 rounded-md shrink-0 bg-fill-weak border border-stroke-weak inline-flex items-center justify-center text-2xs font-semibold text-weak">
      {option.name.slice(0, 2).toUpperCase()}
    </span>
  );
}

/** Only shown when WalletConnect is missing, so the gap is explained instead of silent. */
function WalletConnectHint() {
  const { options } = useWallet();
  if (options.some((o) => o.kind === 'walletconnect')) return null;
  return (
    <p className="mt-4 pt-3 border-t border-stroke-weak text-2xs text-weaker leading-snug">
      Mobile and QR wallets need a free WalletConnect project id in{' '}
      <span className="num">VITE_WALLETCONNECT_PROJECT_ID</span> — see the README.
    </p>
  );
}
