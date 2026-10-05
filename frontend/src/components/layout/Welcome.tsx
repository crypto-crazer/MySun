import { Button } from '@/components/ui/Button';
import { useConnectWallet } from '@/chain/useConnectWallet';

/** First-screen job: identify the product and offer a next step. Shown only before connecting. */
export function Welcome() {
  const { connectWallet, isPending } = useConnectWallet();
  return (
    <>
      <p className="eyebrow !text-weak">Automated liquidity strategies</p>
      <h1 className="title font-thin text-[clamp(52px,6.4vw,92px)] leading-[0.98] -ml-[0.03em]">
        Markets move.<br />Your range <em className="font-light">follows.</em>
      </h1>
      <Button variant="accent" onClick={connectWallet} loading={isPending}>Connect wallet</Button>
    </>
  );
}
