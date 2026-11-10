'use strict';
// Colour arrows by direction: an input arrow (a coin spent) and an output arrow (a coin created) each get a colour, and it reads on the dark canvas for everyone.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../public/js/hopline-style.js');
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

test('directionPalette: the two palettes by key, and nothing for any other key', () => {
  assert.equal(S.directionPalette('rg').name, 'Red and green'); assert.equal(S.directionPalette('bl').name, 'Blue and lime');
  ['', 'x', 'RG', 'constructor', '__proto__', 'toString', 'hasOwnProperty', null, undefined, 7, {}, ['rg']].forEach((k) => assert.equal(S.directionPalette(k), null, String(k)));
});

test('edgeColor: with a palette an input arrow and an output arrow have their colour, and it wins over the age colour of an arrow', () => {
  const g = new Graph();
  g.upsertNode({ id: 'tx:a', type: 'tx', txid: 'a', time: 1650000000, loaded: true }); g.upsertNode({ id: 'addr:w', type: 'addr', address: 'w' });
  const input = { id: 'in:a:0', kind: 'in', source: 'addr:w', target: 'tx:a', amount: 5, time: 1650000000 }, output = { id: 'out:a:0', kind: 'out', source: 'tx:a', target: 'addr:w', amount: 5, time: 1650000000 };
  g.upsertEdge(input); g.upsertEdge(output);
  const vis = { nodes: new Set(['tx:a', 'addr:w']), edges: new Set(['in:a:0', 'out:a:0']) };
  const rg = S.makeStyle(g, vis, { direction: 'rg' }), bl = S.makeStyle(g, vis, { direction: 'bl', colorBy: 'age' });
  assert.equal(rg.edgeColor(input), '#ff6b6b'); assert.equal(rg.edgeColor(output), '#4ade80');
  assert.equal(bl.edgeColor(input), '#3b8bff'); assert.equal(bl.edgeColor(output), '#d8f547');
  assert.equal(S.makeStyle(g, vis, { colorBy: 'age' }).edgeColor(output).slice(0, 4), 'rgb(', 'without it the age colour is what an arrow gets');
  assert.equal(S.makeStyle(g, vis, {}).edgeColor(output), null, 'and by default the renderer\'s neutral grey (null: no colour of its own)');
  assert.equal(S.makeStyle(g, vis, { direction: 'nope' }).edgeColor(output), null, 'a key that is not a palette is not one');
  assert.equal(S.makeStyle(g, vis, { direction: 'constructor' }).edgeColor(output), null);
  assert.equal(S.makeStyle(g, vis, { direction: 'rg' }).edgeColor({ kind: 'weird' }), null, 'an arrow that is neither: no direction colour');
  assert.equal(S.makeStyle(g, vis, { direction: 'rg' }).edgeColor({ id: 'grpe:grp:1', kind: 'out', virtual: true }), '#4ade80', 'the arrow to a folded group is an output like the others');
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

test('palettes: Blue and lime stays at least 45 apart for protanopia, deuteranopia and tritanopia; Red and green does not for red-green colour blindness, which is why the second is offered', () => {
  const bl = S.DIRECTION_PALETTES.bl, rg = S.DIRECTION_PALETTES.rg;
  ['protan', 'deutan', 'tritan'].forEach((k) => assert.ok(apart(hex(bl['in']), hex(bl.out), k) >= 45, 'Blue and lime, ' + k + ': ' + apart(hex(bl['in']), hex(bl.out), k).toFixed(0)));
  assert.ok(apart(hex(rg['in']), hex(rg.out), 'deutan') < 20, 'Red and green with deuteranopia: ' + apart(hex(rg['in']), hex(rg.out), 'deutan').toFixed(0));
  assert.ok(apart(hex(bl['in']), hex(bl.out), 'deutan') > 2 * apart(hex(rg['in']), hex(rg.out), 'deutan'), 'the alternative is a real improvement');
  assert.ok(apart(hex(bl.out), hex('#ff9f43')) >= 50, 'and its output colour is not mistaken for the amber change arrow');
});

test('share links carry the setting: a canvas link and an IDs link keep arrowDir and dirPalette, and the module keeps only plain values (the workspace checks the rest)', () => {
  assert.deepEqual(Share.idsView({ layout: 'flow', arrowDir: true, dirPalette: 'bl', colorBy: 'age' }), { layout: 'flow', colorBy: 'age', arrowDir: true, dirPalette: 'bl' });
  const kept = Share.pruneView({ layout: 'flow', arrowDir: true, dirPalette: 'bl', ext: 1, hidden: ['x'] }, new Set());
  assert.deepEqual(kept, { layout: 'flow', arrowDir: true, dirPalette: 'bl' });
  assert.deepEqual(Share.idsView({ arrowDir: 'yes', dirPalette: { a: 1 } }), { arrowDir: 'yes' });
});
