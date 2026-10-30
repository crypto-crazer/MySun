// The demo worker's fetch handler: static assets behind the per-client page cap (text 429), and
// no proxying at all — `/rpc` is an unknown path that never contacts the retired home tunnel.
// Plain `node --test`, no deps.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { LIMITS } from '../ratelimit.js';

// Any outbound fetch would be a request toward the home Mac (or elsewhere) — fail loudly.
const realFetch = globalThis.fetch;
let upstream;
beforeEach(() => {
  upstream = [];
  globalThis.fetch = async (r) => { upstream.push(new Request(r).url); return new Response('unexpected', { status: 599 }); };
});
afterEach(() => { globalThis.fetch = realFetch; });

const assetsSeen = [];
const env = { ASSETS: { fetch: async (r) => { assetsSeen.push(r); return new Response('<html>', { status: 200 }); } } };
const READ = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
const req = (path, ip, body = READ) =>
  new Request(`https://demo.mysun.dev${path}`, { method: 'POST', headers: { 'cf-connecting-ip': ip }, body });

test('a page over the cap gets a text 429 with Retry-After: 30', async () => {
  const ip = '203.0.113.50';
  for (let i = 0; i < LIMITS.page; i++) assert.equal((await worker.fetch(req('/', ip), env)).status, 200);
  const res = await worker.fetch(req('/', ip), env);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '30');
  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.equal(await res.text(), 'rate limited\n');
  assert.deepEqual(upstream, []);
});

test('/rpc never contacts the tunnel upstream: it is handed to ASSETS like any unknown path', async () => {
  const bodies = [
    READ,
    JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'eth_sendTransaction', params: [{}] }),
    JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, { jsonrpc: '2.0', id: 2, method: 'anvil_setBalance' }]),
    'not json',
  ];
  assetsSeen.length = 0;
  for (const path of ['/rpc', '/rpc/', '/rpc/x']) {
    for (const body of bodies) {
      const res = await worker.fetch(req(path, '203.0.113.51', body), env);
      assert.equal(res.status, 200, `${path} ${body}`);
      assert.equal(await res.text(), '<html>');
    }
  }
  const get = await worker.fetch(new Request('https://demo.mysun.dev/rpc', { headers: { 'cf-connecting-ip': '203.0.113.51' } }), env);
  assert.equal(get.status, 200);
  assert.deepEqual(upstream, [], 'no outbound fetch — chain.mysun.dev is never contacted');
  assert.equal(assetsSeen.length, 3 * bodies.length + 1);
  assert.ok(assetsSeen.every((r) => new URL(r.url).hostname === 'demo.mysun.dev'));
});

test('/rpc shares the page budget: over the cap it answers the text 429, still without upstream', async () => {
  const ip = '2001:db8:50:50::1';
  for (let i = 0; i < LIMITS.page; i++) assert.equal((await worker.fetch(req('/rpc', ip), env)).status, 200);
  // Another address of the same /64 is the same client; a page is refused too.
  for (const path of ['/rpc', '/']) {
    const res = await worker.fetch(req(path, '2001:db8:50:50:ffff::2'), env);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '30');
    assert.match(res.headers.get('content-type'), /text\/plain/);
  }
  assert.deepEqual(upstream, []);
});

test('request bodies reach ASSETS unread', async () => {
  let assetBody;
  const assets = { ASSETS: { fetch: async (r) => { assetBody = await r.text(); return new Response('<html>'); } } };
  const res = await worker.fetch(req('/rpc', '203.0.113.55', JSON.stringify({ method: 'eth_sendTransaction' })), assets);
  assert.equal(res.status, 200);
  assert.equal(assetBody, JSON.stringify({ method: 'eth_sendTransaction' }));
  assert.deepEqual(upstream, []);
});
