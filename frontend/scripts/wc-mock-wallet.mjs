// Mock WalletConnect wallet for pairing tests against the dev/demo app.
//
// Pairs from a `wc:` URI and approves the session with a DUMMY, keyless address — it never signs
// and holds no keys. Use it to exercise the real relay path without a phone:
//
//   1. open the app, click WalletConnect, copy the pairing URI ("Copy link" in the QR modal)
//   2. node scripts/wc-mock-wallet.mjs '<wc:... uri>'
//   3. the app should adopt the session and show the address (0x1111…1111)
//
// usage: node scripts/wc-mock-wallet.mjs <wc:... uri>
import { Core } from '@walletconnect/core';
import { SignClient } from '@walletconnect/sign-client';

// The app's own project id (frontend/.env.local); required — never commit a real id here.
const PROJECT_ID = process.env.VITE_WALLETCONNECT_PROJECT_ID;
if (!PROJECT_ID) {
  console.error('set VITE_WALLETCONNECT_PROJECT_ID (the id in frontend/.env.local), e.g. `set -a; . ./.env.local; set +a`');
  process.exit(1);
}
const ADDRESS = '0x1111111111111111111111111111111111111111';
const uri = process.argv[2];
if (!uri || !uri.startsWith('wc:')) {
  console.error('usage: node scripts/wc-mock-wallet.mjs <wc:... uri>');
  process.exit(1);
}

const core = new Core({ projectId: PROJECT_ID });
const client = await SignClient.init({
  core,
  metadata: { name: 'Mock Wallet', description: 'pairing test wallet', url: 'https://mock.invalid', icons: [] },
});

client.on('session_proposal', async (proposal) => {
  try {
    const req = proposal.params.requiredNamespaces?.eip155;
    const opt = proposal.params.optionalNamespaces?.eip155;
    const chains = req?.chains ?? ['eip155:46630'];
    console.log('proposal: required chains =', JSON.stringify(chains));
    const accounts = chains.map((c) => `${c}:${ADDRESS}`);
    // Methods/events must come from BOTH namespace sets: the app proposes everything as optional
    // (requiredNamespaces is undefined), and a session approved with `methods: []` makes the SDK
    // reject every request ("Missing or invalid. request() method: …") — silently killing the
    // wallet-side switch before it ever hits the relay.
    const namespaces = {
      eip155: {
        accounts,
        methods: [...new Set([...(req?.methods ?? []), ...(opt?.methods ?? []), 'eth_chainId'])],
        events: [...new Set([...(req?.events ?? []), ...(opt?.events ?? []), 'chainChanged', 'accountsChanged'])],
        chains,
      },
    };
    const { acknowledged } = await client.approve({ id: proposal.id, namespaces });
    await acknowledged();
    console.log('APPROVED', JSON.stringify(accounts), 'methods:', JSON.stringify(namespaces.eip155.methods));
    setTimeout(() => process.exit(0), 1500);
  } catch (e) {
    console.error('approve failed:', e);
    process.exit(2);
  }
});

const { topic } = await core.pairing.pair({ uri });
console.log('paired on topic', topic, '— waiting for proposal…');
setTimeout(() => {
  console.log('no proposal after 60s');
  process.exit(3);
}, 60000);
