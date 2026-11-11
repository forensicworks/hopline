'use strict';
// Colour arrows by direction: an input arrow (a coin spent) and an output arrow (a coin created) each get a colour, and it reads on the dark canvas for everyone.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../public/js/hopline-style.js');
const AN = require('../public/js/hopline-analysis.js');
const Share = require('../public/js/hopline-share.js');
const { Graph } = require('../public/js/hopline-model.js');

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
const lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const MAT = {                                                                       // Machado, Oliveira and Fernandes 2009, full severity: how a colour looks with each kind of colour blindness
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]]
};
const seen = (rgb, kind) => MAT[kind].map((row) => Math.min(1, Math.max(0, row[0] * lin(rgb[0]) + row[1] * lin(rgb[1]) + row[2] * lin(rgb[2]))));      // in linear light
function lab(l) {
  let x = (0.4124 * l[0] + 0.3576 * l[1] + 0.1805 * l[2]) / 0.95047, y = 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2], z = (0.0193 * l[0] + 0.1192 * l[1] + 0.9505 * l[2]) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  [x, y, z] = [f(x), f(y), f(z)];
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const apart = (a, b, kind) => { const la = lab(kind ? seen(a, kind) : a.map(lin)), lb = lab(kind ? seen(b, kind) : b.map(lin)); return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]); };
const lum = (rgb) => { const l = rgb.map(lin); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; };
const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const CANVAS = hex('#1c141d');                                                       // the canvas background (HoplineRender's theme)

test('directionPalette: the two palettes by key, and nothing for any other key (Red and green is gone: a file that names it is read with the default)', () => {
  assert.equal(S.directionPalette('pg').name, 'Pink and green'); assert.equal(S.directionPalette('bl').name, 'Blue and lime');
  assert.equal(S.DEFAULT_DIRECTION, 'pg'); assert.deepEqual(Object.keys(S.DIRECTION_PALETTES), ['pg', 'bl']);
  ['', 'x', 'RG', 'rg', 'PG', 'constructor', '__proto__', 'toString', 'hasOwnProperty', null, undefined, 7, {}, ['pg']].forEach((k) => assert.equal(S.directionPalette(k), null, String(k)));
});

test('directionColors: what comes in and what goes out, by the key, and the default pair for anything that is not one', () => {
  assert.deepEqual(S.directionColors('pg'), { arrives: '#6be675', leaves: '#f06bd0' });
  assert.deepEqual(S.directionColors('bl'), { arrives: '#d8f547', leaves: '#3b8bff' });
  [undefined, null, 'rg', 'constructor', 7].forEach((k) => assert.deepEqual(S.directionColors(k), S.directionColors('pg'), String(k)));
  assert.deepEqual(S.directionColors(), { arrives: S.DIRECTION_PALETTES.pg.out, leaves: S.DIRECTION_PALETTES.pg['in'] }, 'an input arrow is the coin that leaves its wallet, an output arrow the coin that arrives');
});

test('edgeColor: with a palette an input arrow and an output arrow have their colour, and it wins over the age colour of an arrow', () => {
  const g = new Graph();
  g.upsertNode({ id: 'tx:a', type: 'tx', txid: 'a', time: 1650000000, loaded: true }); g.upsertNode({ id: 'addr:w', type: 'addr', address: 'w' });
  const input = { id: 'in:a:0', kind: 'in', source: 'addr:w', target: 'tx:a', amount: 5, time: 1650000000 }, output = { id: 'out:a:0', kind: 'out', source: 'tx:a', target: 'addr:w', amount: 5, time: 1650000000 };
  g.upsertEdge(input); g.upsertEdge(output);
  const vis = { nodes: new Set(['tx:a', 'addr:w']), edges: new Set(['in:a:0', 'out:a:0']) };
  const pg = S.makeStyle(g, vis, { direction: 'pg' }), bl = S.makeStyle(g, vis, { direction: 'bl', colorBy: 'age' });
  assert.equal(pg.edgeColor(input), '#f06bd0'); assert.equal(pg.edgeColor(output), '#6be675');
  assert.equal(bl.edgeColor(input), '#3b8bff'); assert.equal(bl.edgeColor(output), '#d8f547');
  assert.equal(S.makeStyle(g, vis, { colorBy: 'age' }).edgeColor(output).slice(0, 4), 'rgb(', 'without it the age colour is what an arrow gets');
  assert.equal(S.makeStyle(g, vis, {}).edgeColor(output), null, 'and by default the renderer\'s neutral grey (null: no colour of its own)');
  assert.equal(S.makeStyle(g, vis, { direction: 'nope' }).edgeColor(output), null, 'a key that is not a palette is not one');
  assert.equal(S.makeStyle(g, vis, { direction: 'constructor' }).edgeColor(output), null);
  assert.equal(S.makeStyle(g, vis, { direction: 'rg' }).edgeColor(output), null, 'the old Red and green is not a palette any more');
  assert.equal(S.makeStyle(g, vis, { direction: 'pg' }).edgeColor({ kind: 'weird' }), null, 'an arrow that is neither: no direction colour');
  assert.equal(S.makeStyle(g, vis, { direction: 'pg' }).edgeColor({ id: 'grpe:grp:1', kind: 'out', virtual: true }), '#6be675', 'the arrow to a folded group is an output like the others');
});

test('palettes: valid colours, two different ones each, and every colour reads on the canvas (contrast of at least 4.5 to 1)', () => {
  Object.keys(S.DIRECTION_PALETTES).forEach((k) => {
    const p = S.DIRECTION_PALETTES[k];
    assert.match(p['in'], /^#[0-9a-f]{6}$/); assert.match(p.out, /^#[0-9a-f]{6}$/); assert.notEqual(p['in'], p.out, k);
    assert.ok(contrast(hex(p['in']), CANVAS) >= 4.5, k + ' input: ' + contrast(hex(p['in']), CANVAS).toFixed(1));
    assert.ok(contrast(hex(p.out), CANVAS) >= 4.5, k + ' output: ' + contrast(hex(p.out), CANVAS).toFixed(1));
    assert.ok(apart(hex(p['in']), hex(p.out)) >= 60, k + ' are plainly different with normal colour vision');
  });
});

test('palettes: both pairs stay at least 45 apart for protanopia, deuteranopia and tritanopia (the old red and green was under 20 for deuteranopia, and orange and green nearly as bad)', () => {
  ['pg', 'bl'].forEach((key) => {
    const p = S.DIRECTION_PALETTES[key];
    ['protan', 'deutan', 'tritan'].forEach((k) => assert.ok(apart(hex(p['in']), hex(p.out), k) >= 45, p.name + ', ' + k + ': ' + apart(hex(p['in']), hex(p.out), k).toFixed(0)));
  });
  assert.ok(apart(hex('#ff6b6b'), hex('#4ade80'), 'deutan') < 20, 'the pair that was dropped, with deuteranopia: ' + apart(hex('#ff6b6b'), hex('#4ade80'), 'deutan').toFixed(0));
  assert.ok(apart(hex('#ff9f43'), hex('#6be675'), 'deutan') < 30, 'and the wallet page old orange and green: ' + apart(hex('#ff9f43'), hex('#6be675'), 'deutan').toFixed(0));
});

test('palettes: neither colour of either pair is mistaken for what else is on the canvas: the address vertex, the amber change arrow, the orange SWAP ring and the red of sanctions', () => {
  const others = { 'address vertex': S.TYPE_COLORS.addr, 'change arrow': AN.COLORS.change, 'SWAP ring': AN.COLORS.swap, 'sanctions ring': '#ff4d4f', 'sanctions badge': '#ff6b6b' };      // the two reds are written in hopline-render.js
  Object.keys(S.DIRECTION_PALETTES).forEach((key) => {
    const p = S.DIRECTION_PALETTES[key];
    [['in', p['in']], ['out', p.out]].forEach(([which, c]) => Object.keys(others).forEach((n) => assert.ok(apart(hex(c), hex(others[n])) >= 50, p.name + ' ' + which + ' (' + c + ') against the ' + n + ' (' + others[n] + '): ' + apart(hex(c), hex(others[n])).toFixed(0))));
  });
});

test('one pair for the whole site: the style sheets of the wallet page and of the workspace hold the colours of Pink and green, and every in and out rule uses them', () => {
  const pg = S.DIRECTION_PALETTES.pg, rgbaOf = (c) => 'rgba(' + hex(c).map((v) => Math.round(v * 255)).join(', ') + ', 0.14)';
  ['wallet.css', 'workspace.css'].forEach((f) => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', f), 'utf8');
    const v = (name) => { const m = css.match(new RegExp('--' + name + ':\\s*([^;]+);')); assert.ok(m, f + ' has --' + name); return m[1].trim(); };
    assert.equal(v('arrive'), pg.out, f); assert.equal(v('leave'), pg['in'], f);
    assert.equal(v('arrive-tint'), rgbaOf(pg.out), f); assert.equal(v('leave-tint'), rgbaOf(pg['in']), f);
  });
  const rules = { 'wallet.css': ['.tx.in', '.tx.out', '.net.in', '.net.out', '.amt.in', '.amt.out', '.charttip .up', '.charttip .down'], 'workspace.css': ['.linkrow.in .amt', '.linkrow.out .amt', '.dirtag.in', '.dirtag.out'] };
  Object.keys(rules).forEach((f) => {
    const lines = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', f), 'utf8').split(/\r?\n/);
    rules[f].forEach((sel) => {
      const line = lines.find((l) => l.startsWith(sel + ' {'));
      assert.ok(line, f + ' has the rule ' + sel); assert.match(line, /var\(--(arrive|leave)(-tint)?\)/, f + ' ' + sel + ' uses the shared colour'); assert.doesNotMatch(line, /#[0-9a-f]{3,6}\b|rgba?\(/i, f + ' ' + sel + ' has no colour of its own');
    });
  });
  const wallet = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'wallet.js'), 'utf8');
  assert.match(wallet, /UP = S\.directionColors\(\)\.arrives, DOWN = S\.directionColors\(\)\.leaves/, 'the bars of the wallet chart take the colours from the style module');
});

test('share links carry the setting: a canvas link and an IDs link keep arrowDir and dirPalette, and the module keeps only plain values (the workspace checks the rest)', () => {
  assert.deepEqual(Share.idsView({ layout: 'flow', arrowDir: true, dirPalette: 'bl', colorBy: 'age' }), { layout: 'flow', colorBy: 'age', arrowDir: true, dirPalette: 'bl' });
  const kept = Share.pruneView({ layout: 'flow', arrowDir: true, dirPalette: 'bl', ext: 1, hidden: ['x'] }, new Set());
  assert.deepEqual(kept, { layout: 'flow', arrowDir: true, dirPalette: 'bl' });
  assert.deepEqual(Share.idsView({ arrowDir: 'yes', dirPalette: { a: 1 } }), { arrowDir: 'yes' });
});
