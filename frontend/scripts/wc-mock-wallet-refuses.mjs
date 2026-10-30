// Refusing-wallet mock: mimics a mobile wallet that approves the session with ITS OWN network
// (eip155:1) alongside the dapp-required chain, chain 1 FIRST — which makes the SDK report
// eth_chainId = 1 ("Chain 1" in the app). It stays alive a while and answers wallet_switch/add
// with 4902 (like a wallet stranded on its own network that cannot add chains), so the app's
// switch-failure path can be exercised end to end (see notes/WALLETS.md).
// usage: node scripts/wc-mock-wallet-refuses.mjs <wc:... uri>
import { Core } from '@walletconnect/core';
import { SignClient } from '@walletconnect/sign-client';

// The app's own project id (frontend/.env.local); required — never commit a real id here.
const PROJECT_ID = process.env.VITE_WALLETCONNECT_PROJECT_ID;
if (!PROJECT_ID) {
  console.error('set VITE_WALLETCONNECT_PROJECT_ID (the id in frontend/.env.local), e.g. `set -a; . ./.env.local; set +a`');
  process.exit(1);
}
const ADDRESS = '0x2222222222222222222222222222222222222222';
const uri = process.argv[2];
if (!uri || !uri.startsWith('wc:')) {
  console.error('usage: node scripts/wc-mock-v2-test.mjs <wc:... uri>');
  process.exit(1);
}

const core = new Core({ projectId: PROJECT_ID });
const client = await SignClient.init({
  core,
  metadata: { name: 'Mock Wallet V2', description: 'repro wallet (chain 1 first)', url: 'https://mock.invalid', icons: [] },
});

client.on('session_proposal', async (proposal) => {
  const req = proposal.params.requiredNamespaces?.eip155;
  const opt = proposal.params.optionalNamespaces?.eip155;
  console.log('proposal: required =', JSON.stringify(req?.chains), ' optional =', JSON.stringify(opt?.chains));
  // The wallet's own network first, then the dapp's required chain (like MetaMask mobile does).
  const chains = ['eip155:1', ...(req?.chains ?? ['eip155:46630'])];
  const accounts = chains.map((c) => `${c}:${ADDRESS}`);
  const namespaces = {
    eip155: {
      accounts,
      methods: [...new Set([...(req?.methods ?? []), 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'eth_sendTransaction', 'personal_sign'])],
      events: req?.events ?? ['chainChanged', 'accountsChanged'],
      chains,
    },
  };
  const { acknowledged } = await client.approve({ id: proposal.id, namespaces });
  await acknowledged();
  console.log('APPROVED with chains', JSON.stringify(chains), 'accounts', JSON.stringify(accounts));
});

client.on('session_request', async (event) => {
  const { id, params } = event;
  const method = params?.request?.method;
  console.log('WALLET RECEIVED:', method, JSON.stringify(params?.request?.params ?? params?.request));
  // A wallet that cannot switch/add the chain refuses — like the reported case.
  try {
    await client.respond({
      topic: event.topic,
      response: { id, jsonrpc: '2.0', error: { code: 4902, message: 'Unrecognized chain ID — this wallet cannot switch to it.' } },
    });
    console.log('responded 4902 to', method);
  } catch (e) {
    console.error('respond failed:', e);
  }
});

const { topic } = await core.pairing.pair({ uri });
console.log('paired on topic', topic, '— waiting…');
setTimeout(() => { console.log('done (timeout)'); process.exit(0); }, 240000);
