'use strict';
// The start page: what the box holds and which pages can open it.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../public/js/hopline-front.js');

const BECH = 'bc1qq2euq8pw950klpjcawuy4uj39ym43hs6cfsegq';          // the sample wallet of the wallet page
const LEGACY = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const TAPROOT = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0';
const TX = '0f58c9a7aee48bd72ffd929fd3ac80bf95db5be13a6493b2f954de9ae659710d';
const TX2 = 'a'.repeat(64);

const pages = (r) => r.offers.map((o) => o.page + (o.url ? '' : '(off)'));

test('nothing in the box offers nothing', () => {
  for (const t of ['', '   ', null, undefined, '\n']) {
    const r = F.classify(t);
    assert.equal(r.kind, 'empty'); assert.deepEqual(r.offers, []); assert.equal(r.chip, '');
  }
});

test('one address: the overview first (as before), the workspace second', () => {
  for (const a of [BECH, LEGACY, TAPROOT]) {
    const r = F.classify('  ' + a + '  ');
    assert.equal(r.kind, 'address'); assert.equal(r.chip, 'Bitcoin address');
    assert.deepEqual(pages(r), ['wallet', 'workspace']);
    assert.equal(r.offers[0].url, 'public/wallet.html?q=' + a);
    assert.equal(r.offers[1].url, 'public/workspace.html?q=' + a);
  }
});

test('capitals from an autocorrecting keyboard or a QR code are put right for a bech32 address, never for a legacy one', () => {
  assert.equal(F.classify('Bc1' + BECH.slice(3)).offers[0].url, 'public/wallet.html?q=' + BECH);
  assert.equal(F.classify(BECH.toUpperCase()).offers[0].url, 'public/wallet.html?q=' + BECH);
  assert.equal(F.classify(LEGACY.toLowerCase()).kind, 'invalid', 'a legacy address is case-sensitive: lower-casing it breaks the checksum');
});

test('one transaction ID: the workspace, and the overview says why it cannot take it', () => {
  const r = F.classify(TX.toUpperCase());
  assert.equal(r.kind, 'transaction'); assert.equal(r.chip, 'Transaction ID');
  assert.deepEqual(pages(r), ['workspace', 'wallet(off)']);
  assert.equal(r.offers[0].url, 'public/workspace.html?q=' + TX, 'lower-cased, and the address the page has always been given');
  assert.match(r.offers[1].why, /no overview of its own/);
});

test('2 to 10 entries: the workspace only, each once, in the order they came', () => {
  const r = F.classify([BECH, TX, LEGACY, TX2, TX].join('\n'));
  assert.equal(r.kind, 'several'); assert.equal(r.chip, '2 addresses and 2 transactions', 'the repeated ID is counted once');
  assert.deepEqual(pages(r), ['workspace', 'wallet(off)']);
  assert.deepEqual(r.items.map((i) => i.value), [BECH, TX, LEGACY, TX2]);
  assert.equal(r.offers[0].url, 'public/workspace.html?q=' + encodeURIComponent([BECH, TX, LEGACY, TX2].join(' ')));
  assert.match(r.offers[1].why, /one address/);
  assert.equal(F.classify(BECH + ', ' + LEGACY).chip, '2 addresses');
  assert.equal(F.classify(TX + ';' + TX2).chip, '2 transactions');
});

test('the same address twice is one address, and that opens the overview', () => {
  const r = F.classify(BECH + ' ' + BECH);
  assert.equal(r.kind, 'address'); assert.equal(r.items.length, 1);
});

test('more than ten is refused with the number the workspace takes', () => {
  const many = []; for (let i = 0; i < 11; i++) many.push(i.toString(16).padStart(64, '0'));
  const r = F.classify(many.join(' '));
  assert.equal(r.kind, 'toomany'); assert.deepEqual(r.offers, []); assert.match(r.message, /up to 10/);
  assert.equal(F.classify(many.slice(0, 10).join(' ')).kind, 'several', 'ten are fine');
});

test('explorer links and bitcoin: URIs are understood', () => {
  assert.equal(F.classify('https://mempool.space/address/' + BECH).offers[0].url, 'public/wallet.html?q=' + BECH);
  assert.equal(F.classify('https://mempool.space/address/' + BECH.toUpperCase() + '/').offers[0].url, 'public/wallet.html?q=' + BECH);
  assert.equal(F.classify('bitcoin:' + BECH + '?amount=1&label=x').offers[0].url, 'public/wallet.html?q=' + BECH);
  assert.equal(F.classify('https://blockstream.info/tx/' + TX).offers[0].url, 'public/workspace.html?q=' + TX);
});

test('a Hopline link opens the workspace with its own part after the #', () => {
  for (const h of ['#s1/eJxLy0ktAQAEHgHq', '#i1/AbC-_9']) {
    for (const t of [h, 'https://hopline.pages.dev/public/workspace.html' + h, 'file:///C:/x/public/workspace.html' + h]) {
      const r = F.classify(t);
      assert.equal(r.kind, 'link', t); assert.deepEqual(pages(r), ['workspace']);
      assert.equal(r.offers[0].url, 'public/workspace.html' + h);
    }
  }
  assert.equal(F.classify('#s1/').kind, 'invalid', 'a link with nothing in it is not one');
  assert.equal(F.classify('#x9/abc').kind, 'invalid');
});

test('a checksum that does not fit is said so before any page opens, with the sentence the pages use', () => {
  const typo = BECH.slice(0, -1) + (BECH.endsWith('q') ? 'p' : 'q');
  const r = F.classify(typo);
  assert.equal(r.kind, 'invalid'); assert.equal(r.chip, 'Not recognised'); assert.deepEqual(r.offers, []);
  assert.match(r.message, /checksum does not match/);
  assert.match(F.classify(LEGACY.slice(0, -1) + '1').message, /legacy address/);
});

test('words, and an entry that is not one, are not recognised', () => {
  const r = F.classify('this is not a bitcoin address at all');
  assert.equal(r.kind, 'invalid'); assert.match(r.chip, /not recognised/);
  const mixed = F.classify(BECH + ' hello-world-this-is-long');
  assert.equal(mixed.kind, 'invalid'); assert.equal(mixed.chip, '1 of 2 not recognised'); assert.match(mixed.message, /Nothing is opened until/);
  assert.equal(F.classify('x'.repeat(64)).kind, 'invalid', '64 characters but not hexadecimal');
});

test('something short is taken to be unfinished, not wrong, while it is being typed', () => {
  assert.equal(F.classify('bc1qq2e').kind, 'typing');
  assert.equal(F.classify('hello').kind, 'typing');
  assert.equal(F.classify('bc1qq2euq8pw950klpjcawuy4uj39ym43hs6cfseg').kind, 'invalid', 'long enough to be a whole address, so it is judged');
  assert.equal(F.classify('abc def').kind, 'invalid', 'two pieces are not one thing being typed');
});

test('what is offered is always a page of this site, never an address that came from the text', () => {
  for (const t of [BECH, TX, [BECH, TX].join(' '), '#s1/abc']) {
    for (const o of F.classify(t).offers) if (o.url) assert.match(o.url, /^public\/(wallet|workspace)\.html(\?q=[A-Za-z0-9%._~-]+|#(s1|i1)\/[A-Za-z0-9_-]+)$/);
  }
});
