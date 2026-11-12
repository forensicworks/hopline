'use strict';
// The version a page shows, and when a page left open should say the site has a newer one.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../public/js/hopline-version.js');

const OWN = { version: 'ae67f10', committed: '2026-11-12T00:36:21Z' };

test('a version is a short id, with a date only when it is a UTC time', () => {
  assert.deepEqual(V.parse({ version: 'ae67f10', committed: '2026-11-12T00:36:21Z' }), OWN);
  assert.deepEqual(V.parse({ version: 'ae67f10' }), { version: 'ae67f10', committed: null });
  assert.deepEqual(V.parse({ version: 'ae67f10', committed: 'yesterday' }), { version: 'ae67f10', committed: null });
  assert.deepEqual(V.parse({ version: 'ae67f10', committed: '2026-11-12 00:36:21' }), { version: 'ae67f10', committed: null });
  for (const bad of [null, undefined, 'ae67f10', 5, [], {}, { version: '' }, { version: 5 }, { version: 'a b' }, { version: 'x'.repeat(41) }, { version: '<b>' }]) assert.equal(V.parse(bad), null, JSON.stringify(bad));
});

test('only a version committed later counts as newer, never one that is merely different', () => {
  const later = { version: 'bbbbbbb', committed: '2026-11-12T00:36:22Z' };
  assert.equal(V.isNewer(OWN, later), true);
  assert.equal(V.isNewer(OWN, { version: 'bbbbbbb', committed: '2026-11-12T00:36:21Z' }), false, 'the same moment under another id');
  assert.equal(V.isNewer(OWN, { version: 'bbbbbbb', committed: '2026-11-11T23:59:59Z' }), false, 'older: the copy that is served is behind, or was rolled back');
  assert.equal(V.isNewer(OWN, { version: OWN.version, committed: '2030-01-01T00:00:00Z' }), false, 'the same version is never newer');
  assert.equal(V.isNewer(OWN, { version: 'bbbbbbb', committed: null }), false, 'no date: different, not known to be newer');
  assert.equal(V.isNewer({ version: 'ae67f10', committed: null }, later), false, 'this page does not know its own date either');
  assert.equal(V.isNewer(null, later), false); assert.equal(V.isNewer(OWN, null), false);
  assert.equal(V.isNewer(OWN, { version: 'bbbbbbb', committed: '2027-01-01T00:00:00Z' }), true, 'dates compare as times, across years');
});

test('a time is written for a person, in UTC', () => {
  assert.equal(V.when('2026-11-12T00:36:21Z'), '12 Nov 2026 00:36 UTC');
  assert.equal(V.when('2026-01-05T13:07:00Z'), '5 Jan 2026 13:07 UTC');
  assert.equal(V.when(null), ''); assert.equal(V.when('soon'), '');
  assert.equal(V.describe(OWN), 'ae67f10, committed 12 Nov 2026 00:36 UTC');
  assert.equal(V.describe({ version: 'ae67f10', committed: null }), 'ae67f10');
});

test('a page looks again when it never has, or when long enough has passed', () => {
  assert.equal(V.due(1000, null, 600000), true);
  assert.equal(V.due(1000, 900, 600000), false);
  assert.equal(V.due(600900, 900, 600000), true);
  assert.equal(V.due(600899, 900, 600000), false);
});

test('nothing starts by itself in a place without a page, and a window without a version is left alone', () => {
  assert.equal(typeof V.start, 'function');
  const doc = { querySelectorAll: () => { throw new Error('a page with no version looks at nothing'); }, getElementById: () => { throw new Error('nor does it look for the bar'); } };
  assert.equal(V.start({ document: doc, HOPLINE_CONFIG: {} }), null);
  assert.equal(V.start({ document: doc }), null);
  assert.equal(V.start({ document: doc, HOPLINE_CONFIG: { version: 'a b' } }), null);
});

test('the timing is the same for everyone unless the settings say otherwise: a first look soon after the page opens, then every half hour', () => {
  assert.equal(V.FIRST_MS, 3000); assert.equal(V.EVERY_MS, 30 * 60 * 1000); assert.equal(V.IDLE_MS, 10 * 60 * 1000);
});
