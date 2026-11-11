'use strict';
// Keeping password managers out of the fields (public/js/hopline-noautofill.js): which elements are covered, what they get, what is left alone. Plain stand-ins for elements, no browser.
const test = require('node:test');
const assert = require('node:assert');
const N = require('../public/js/hopline-noautofill.js');

function el(tag, attrs, inner) {
  const a = Object.assign({}, attrs || {});
  return { nodeType: 1, tagName: tag.toUpperCase(), attrs: a, type: a.type, hasAttribute: (k) => k in a, getAttribute: (k) => (k in a ? a[k] : null), setAttribute: (k, v) => { a[k] = String(v); },
           querySelectorAll: (sel) => { assert.equal(sel, 'input, textarea, select'); return inner || []; } };
}
const ALL = { autocomplete: 'off', 'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other', 'data-protonpass-ignore': 'true' };

test('the attributes: autocomplete off and the ignore attribute of each manager', () => {
  assert.deepEqual(Object.fromEntries(N.ATTRS), ALL);
});

test('covers: every kind of box a person types or chooses in, and nothing else', () => {
  ['text', 'search', 'number', 'date', 'time', 'checkbox', 'radio', 'range', 'file', 'email', 'url', 'password', 'color'].forEach((t) => assert.equal(N.covers(el('input', { type: t })), true, t));
  assert.equal(N.covers(el('input', {})), true, 'an input with no type is a text box');
  assert.equal(N.covers(el('textarea')), true); assert.equal(N.covers(el('select')), true);
  ['hidden', 'submit', 'button', 'reset', 'image', 'HIDDEN', 'Submit'].forEach((t) => assert.equal(N.covers(el('input', { type: t })), false, t));
  ['div', 'button', 'a', 'label', 'form', 'option', 'span'].forEach((t) => assert.equal(N.covers(el(t)), false, t));
  [null, undefined, {}, 'input', 7].forEach((x) => assert.equal(N.covers(x), false, String(x)));
});

test('a field that says data-autofill="allow" is left exactly as it is: the key fields', () => {
  const key = el('input', { type: 'password', 'data-autofill': 'allow', autocomplete: 'off' });
  assert.equal(N.covers(key), false); assert.equal(N.mark(key), false);
  assert.deepEqual(key.attrs, { type: 'password', 'data-autofill': 'allow', autocomplete: 'off' }, 'not one attribute added or changed');
  assert.equal(N.covers(el('input', { type: 'text', 'data-autofill': 'deny' })), true, 'only the value allow keeps a field out');
});

test('mark: a field gets all of them, once, and a value it already has stays', () => {
  const f = el('input', { type: 'text' });
  assert.equal(N.mark(f), true); assert.deepEqual(f.attrs, Object.assign({ type: 'text' }, ALL));
  assert.equal(N.mark(f), true); assert.deepEqual(f.attrs, Object.assign({ type: 'text' }, ALL), 'again changes nothing');
  const own = el('input', { type: 'text', autocomplete: 'username', 'data-lpignore': 'false' });
  N.mark(own);
  assert.equal(own.attrs.autocomplete, 'username', 'an autocomplete value that was chosen stays'); assert.equal(own.attrs['data-lpignore'], 'false', 'and so does an ignore value');
  assert.equal(own.attrs['data-1p-ignore'], 'true', 'the ones it lacks are added');
  const btn = el('input', { type: 'button' });
  assert.equal(N.mark(btn), false); assert.deepEqual(btn.attrs, { type: 'button' });
});

test('markAll: the element and every field inside it, counted; text nodes and the like are skipped', () => {
  const a = el('input', { type: 'text' }), b = el('select'), c = el('input', { type: 'hidden' }), d = el('input', { type: 'password', 'data-autofill': 'allow' });
  const box = el('div', {}, [a, b, c, d]);
  assert.equal(N.markAll(box), 2); assert.equal(a.attrs['data-1p-ignore'], 'true'); assert.equal(b.attrs['data-bwignore'], 'true'); assert.equal(c.attrs['data-1p-ignore'], undefined); assert.equal(d.attrs['data-1p-ignore'], undefined);
  const lone = el('textarea', {}, []);
  assert.equal(N.markAll(lone), 1, 'a field added on its own is marked too');
  assert.equal(N.markAll({ nodeType: 3 }), 0); assert.equal(N.markAll(null), 0); assert.equal(N.markAll(undefined), 0);
});

test('start: marks what is there, then what the page adds, and again when it has been read', () => {
  const had = el('input', { type: 'text' }), later = el('input', { type: 'text' }), laterAllowed = el('input', { type: 'password', 'data-autofill': 'allow' });
  const root = el('html', {}, [had]);
  const listeners = {}, doc = { documentElement: root, addEventListener: (n, f) => { listeners[n] = f; } };
  let observed = null, callback = null;
  const was = global.MutationObserver;
  global.MutationObserver = class { constructor(cb) { callback = cb; } observe(target, opts) { observed = [target, opts]; } };
  try {
    const ob = N.start(doc);
    assert.ok(ob, 'an observer is returned'); assert.equal(had.attrs['data-1p-ignore'], 'true', 'what was there is marked at once');
    assert.deepEqual(observed, [doc, { childList: true, subtree: true }], 'the whole document, including what is added deep inside it');
    callback([{ addedNodes: [later, laterAllowed, { nodeType: 3 }] }, { addedNodes: [] }]);
    assert.equal(later.attrs['data-bwignore'], 'true', 'a field added later is marked'); assert.equal(laterAllowed.attrs['data-bwignore'], undefined, 'and a key field is not');
    delete had.attrs['data-lpignore']; listeners.DOMContentLoaded();
    assert.equal(had.attrs['data-lpignore'], 'true', 'once the page has been read everything is gone over again');
    global.MutationObserver = undefined;
    const noObserver = { documentElement: el('html', {}, [el('input', { type: 'text' })]), addEventListener: (n, f) => { listeners[n] = f; } };
    assert.equal(N.start(noObserver), null, 'without MutationObserver there is no observer, and the fields are marked when the page has been read');
    assert.equal(typeof listeners.DOMContentLoaded, 'function');
  } finally { global.MutationObserver = was; }
});
