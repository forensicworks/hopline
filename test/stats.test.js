'use strict';
// The visit counter's rules: where it may send, what it may send, and when it must stay quiet.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/js/hopline-stats.js');

test('only a plain https address is accepted as the counting address', () => {
  assert.equal(S.endpointOf({ stats: { endpoint: 'https://my-site.goatcounter.com/count' } }), 'https://my-site.goatcounter.com/count');
  assert.equal(S.endpointOf({ stats: { endpoint: 'https://stats.example.org:8443/count' } }), 'https://stats.example.org:8443/count');
  for (const bad of ['http://x.example/count', 'https://x.example/count?site=1', 'https://x.example/count#a', 'https://user@x.example/count', 'https://x.example', '//x.example/count', 'javascript:1', '', null, 5]) {
    assert.equal(S.endpointOf({ stats: { endpoint: bad } }), null, String(bad));
  }
  assert.equal(S.endpointOf({}), null); assert.equal(S.endpointOf(null), null); assert.equal(S.endpointOf({ stats: 'https://x.example/count' }), null);
});

test('a page is counted under one of three fixed names, whatever its address says', () => {
  assert.equal(S.pagePath('/hopline/index.html'), '/');
  assert.equal(S.pagePath('/hopline/'), '/');
  assert.equal(S.pagePath('/hopline/public/wallet.html'), '/wallet');
  assert.equal(S.pagePath('/C:/Users/x/public/workspace.html'), '/workspace');
  assert.equal(S.pagePath('/hopline/public/other.html'), null);
  assert.equal(S.pagePath('/hopline/public/wallet.html/bc1qsecret'), null, 'an address-looking tail is not a page');
  assert.equal(S.pagePath('/constructor'), null); assert.equal(S.pagePath('/__proto__'), null);
});

test('an event name is a short fixed word, never free text', () => {
  for (const ok of ['report', 'trace-start', 'export-csv-edges', 'wallet-csv']) assert.equal(S.eventName(ok), ok);
  for (const bad of ['', '/report', 'Report', 'bc1qabc def', 'a'.repeat(41), '1abc', 'x?y=1', null, undefined, 7, {}]) assert.equal(S.eventName(bad), null, String(bad));
});

test('the request holds the name, the event flag and a throw-away number, and nothing else', () => {
  assert.equal(S.pixelUrl('https://a.example/count', '/workspace', false, 'k1'), 'https://a.example/count?p=%2Fworkspace&rnd=k1');
  assert.equal(S.pixelUrl('https://a.example/count', 'report', true, 'k2'), 'https://a.example/count?p=report&e=1&rnd=k2');
});

test('Do Not Track and Global Privacy Control are respected', () => {
  assert.equal(S.optedOut({ doNotTrack: '1' }, {}), true);
  assert.equal(S.optedOut({ doNotTrack: 'yes' }, {}), true);
  assert.equal(S.optedOut({ globalPrivacyControl: true }, {}), true);
  assert.equal(S.optedOut({}, { doNotTrack: '1' }), true);
  assert.equal(S.optedOut({ doNotTrack: '0' }, {}), false);
  assert.equal(S.optedOut({}, {}), false); assert.equal(S.optedOut(null, null), false);
});

test('without settings, or after an opt-out, the counter is off and sends nothing', () => {
  const sent = [];
  function Image() { Object.defineProperty(this, 'src', { set: (v) => sent.push(v) }); }
  const base = { Image, location: { pathname: '/public/workspace.html' }, navigator: {} };
  const off = S.create(Object.assign({}, base)); assert.equal(off.enabled, false); assert.equal(off.hit('report'), false); assert.equal(off.page(), false);
  const dnt = S.create(Object.assign({}, base, { HOPLINE_CONFIG: { stats: { endpoint: 'https://a.example/count' } }, navigator: { doNotTrack: '1' } })); assert.equal(dnt.enabled, false); assert.equal(dnt.hit('report'), false);
  assert.deepEqual(sent, []);
  const on = S.create(Object.assign({}, base, { HOPLINE_CONFIG: { stats: { endpoint: 'https://a.example/count' } } }));
  assert.equal(on.enabled, true); assert.equal(on.page(), true); assert.equal(on.hit('report'), true); assert.equal(on.hit('bc1q free text'), false);
  assert.equal(sent.length, 2); assert.match(sent[0], /^https:\/\/a\.example\/count\?p=%2Fworkspace&rnd=/); assert.match(sent[1], /^https:\/\/a\.example\/count\?p=report&e=1&rnd=/);
});
