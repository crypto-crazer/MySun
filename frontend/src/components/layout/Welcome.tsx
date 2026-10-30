import { Button } from '@/components/ui/Button';
import { useConnectWallet } from '@/chain/useConnectWallet';

/**
 * First-screen job: identify the product and offer a next step. The title stays until there are
 * deposits to show; the page says whether the connect button shows (it goes once a wallet is connected).
 */
export function Welcome({ showConnect }: { showConnect: boolean }) {
  const { connectWallet, isPending } = useConnectWallet();
  return (
    <>
      {/* On phones the size keeps "Your range follows." on one line, so the title reads in two as on desktop */}
      <h1 className="title text-[clamp(38px,11.6vw,52px)] leading-[0.98] -ml-[0.03em] sm:text-[clamp(52px,6.4vw,92px)]">
        Markets move.<br />Your range <em className="font-light">follows.</em>
      </h1>
      {showConnect && <Button variant="accent" onClick={connectWallet} loading={isPending}>Connect wallet</Button>}
    </>
  );
}
