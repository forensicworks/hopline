/*
 * Hopline: keep password managers out of the fields. Nothing here is a login, but a page that holds a password-type field (the keys for a server and for Arkham) is taken for one,
 * and a manager then offers to fill and save in every box. Each manager has its own way of being told to leave a field alone, and "autocomplete=off" is largely ignored by them, so a field
 * gets all of them: autocomplete="off", and the ignore attribute of 1Password, LastPass, Bitwarden, Dashlane and Proton Pass (a vendor attribute that is not known to a manager does nothing).
 *
 * Every input (except a button, a hidden field and the like), every textarea and every select gets them as it appears on the page, including the ones the page makes later. A field with
 * data-autofill="allow" is left exactly as it is: the two key fields, which a person may want a manager to keep. A value a field already has is not replaced.
 *
 * The attributes are what the managers document or commonly honour; they can change, and no page can force a manager. A manager's own "never fill on this site" is the sure way.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HoplineNoAutofill = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ATTRS = [['autocomplete', 'off'], ['data-1p-ignore', 'true'], ['data-lpignore', 'true'], ['data-bwignore', 'true'], ['data-form-type', 'other'], ['data-protonpass-ignore', 'true']];
  var FIELDS = 'input, textarea, select', NOT_A_FIELD = /^(hidden|submit|button|reset|image)$/i, ALLOW = 'data-autofill';

  /** Does this element get the attributes? A field, but not a button, a hidden field or one that says data-autofill="allow". Works on anything with tagName, type and getAttribute. */
  function covers(el) {
    if (!el || typeof el.tagName !== 'string') return false;
    var tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return false;
    if (tag === 'input' && NOT_A_FIELD.test(String(el.getAttribute('type') || el.type || 'text'))) return false;
    return el.getAttribute(ALLOW) !== 'allow';
  }
  /** Put the attributes on one field that does not have them; true when it was one that is covered. */
  function mark(el) {
    if (!covers(el)) return false;
    ATTRS.forEach(function (a) { if (!el.hasAttribute(a[0])) el.setAttribute(a[0], a[1]); });
    return true;
  }
  /** Mark the element and every field inside it; returns how many fields were covered. */
  function markAll(node) {
    var n = 0;
    if (!node || node.nodeType !== 1) return 0;
    if (mark(node)) n++;
    if (typeof node.querySelectorAll === 'function') Array.prototype.forEach.call(node.querySelectorAll(FIELDS), function (el) { if (mark(el)) n++; });
    return n;
  }
  /** Mark the fields of a document now and the ones added to it from here on (while the page is still being read, too). */
  function start(doc) {
    doc = doc || document;
    markAll(doc.documentElement);
    if (typeof MutationObserver !== 'function') { doc.addEventListener('DOMContentLoaded', function () { markAll(doc.documentElement); }); return null; }
    var ob = new MutationObserver(function (list) {
      list.forEach(function (m) { Array.prototype.forEach.call(m.addedNodes, markAll); });
    });
    ob.observe(doc, { childList: true, subtree: true });
    doc.addEventListener('DOMContentLoaded', function () { markAll(doc.documentElement); });             // whatever the observer could not see before the body existed
    return ob;
  }

  if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.documentElement) start(document);
  return { ATTRS: ATTRS, covers: covers, mark: mark, markAll: markAll, start: start };
}));
