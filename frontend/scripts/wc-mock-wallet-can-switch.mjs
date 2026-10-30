// Cooperative-wallet mock: approves the session with the wallet's own network (eip155:1) FIRST
// plus the dapp's Demo Chain — like a mobile wallet that knows the chain — and actually PERFORMS
// `wallet_switchEthereumChain`. Wallet-side counterpart of wc-mock-wallet-refuses.mjs: with this
// one the app's switch path succeeds end to end (see notes/WALLETS.md).
//
// Stateful, like a real wallet: it emits `chainChanged` only when the chain actually changes
// (switching to the chain it is already on is a silent no-op), and chains outside the session get
// EIP-3326's 4902. An unconditional emit (this mock's first version) made the dapp's own
// chainChanged handling ping-pong — real wallets do not re-announce a chain nothing changed on.
//
// usage: node scripts/wc-mock-wallet-can-switch.mjs <wc:... uri>
import { Core } from '@walletconnect/core';
import { SignClient } from '@walletconnect/sign-client';

// The app's own project id (frontend/.env.local); required — never commit a real id here.
const PROJECT_ID = process.env.VITE_WALLETCONNECT_PROJECT_ID;
if (!PROJECT_ID) {
  console.error('set VITE_WALLETCONNECT_PROJECT_ID (the id in frontend/.env.local), e.g. `set -a; . ./.env.local; set +a`');
  process.exit(1);
}
const ADDRESS = '0x3333333333333333333333333333333333333333';
const DAPP_CHAIN = 'eip155:46630';
const CHAIN_HEX = '0xb626'; // 46630
const KNOWN_CHAINS = { '0x1': 'eip155:1', '0xb626': 'eip155:46630', '0x1237': 'eip155:4663' };
let currentHex = '0x1'; // the wallet starts on its own network, like a mobile wallet would
const uri = process.argv[2];
if (!uri || !uri.startsWith('wc:')) {
  console.error('usage: node scripts/wc-mock-wallet-can-switch.mjs <wc:... uri>');
  process.exit(1);
}

const core = new Core({ projectId: PROJECT_ID });
const client = await SignClient.init({
  core,
  metadata: { name: 'Mock Wallet (can switch)', description: 'cooperative mock', url: 'https://mock.invalid', icons: [] },
});

client.on('session_proposal', async (proposal) => {
  const req = proposal.params.requiredNamespaces?.eip155;
  const opt = proposal.params.optionalNamespaces?.eip155;
  console.log('proposal: required =', JSON.stringify(req?.chains), ' optional =', JSON.stringify(opt?.chains));
  const chains = ['eip155:1', ...(req?.chains ?? []), ...(opt?.chains ?? []).filter((c) => c !== 'eip155:1')];
  const dedup = [...new Set(chains)];
  const namespaces = {
    eip155: {
      accounts: dedup.map((c) => `${c}:${ADDRESS}`),
      methods: [...new Set([...(req?.methods ?? []), ...(opt?.methods ?? []), 'eth_chainId'])],
      events: ['chainChanged', 'accountsChanged'],
      chains: dedup,
    },
  };
  const { acknowledged } = await client.approve({ id: proposal.id, namespaces });
  await acknowledged();
  console.log('APPROVED with chains', JSON.stringify(dedup));
});

client.on('session_request', async (event) => {
  const { id, params } = event;
  const method = params?.request?.method;
  console.log('WALLET RECEIVED:', method, JSON.stringify(params?.request?.params ?? ''));
  const respond = (result) =>
    client.respond({ topic: event.topic, response: { id, jsonrpc: '2.0', result } });
  const respondError = (code, message) =>
    client.respond({ topic: event.topic, response: { id, jsonrpc: '2.0', error: { code, message } } });
  try {
    if (method === 'wallet_switchEthereumChain') {
      const hex = String(params?.request?.params?.[0]?.chainId ?? '').toLowerCase();
      const caip = KNOWN_CHAINS[hex];
      if (!caip) {
        await respondError(4902, `Unrecognized chain ID ${hex}`);
        console.log('REFUSED switch to', hex, '— not a chain this wallet knows');
      } else if (hex === currentHex) {
        await respond(null);
        console.log('switch no-op — already on', hex);
      } else {
        currentHex = hex;
        await respond(null);
        await client.emit({ topic: event.topic, event: { name: 'chainChanged', data: caip }, chainId: caip });
        console.log('SWITCHED ✓ — chainChanged →', caip);
      }
    } else if (method === 'wallet_addEthereumChain') {
      await respond(null);
      console.log('add acknowledged');
    } else if (method === 'eth_chainId') {
      await respond(currentHex);
    } else if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
      await respond([ADDRESS]);
    } else {
      await respond(null);
    }
  } catch (e) {
    console.error('respond failed:', e);
  }
});

const { topic } = await core.pairing.pair({ uri });
console.log('paired on topic', topic, '— waiting…');
setTimeout(() => { console.log('done (timeout)'); process.exit(0); }, 240000);
