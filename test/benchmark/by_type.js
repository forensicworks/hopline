'use strict';
// For a real-wallet case: how the change guess does, split by the address type of the payment's recipient and by the type of the coins the wallet spent.
// Only transactions with one payment and one change output, with the change known from the wallet's own change chain.
//
//   node test/benchmark/by_type.js test/benchmark/cases/wallets-v1/signet-core-1 [more case folders]
//
// "type alone" is a guess that rests on the one sign "the only output of the same address type as the inputs". It fails when a wallet changes to a type other
// than the one it receives on and the recipient has the type of the coins the wallet spends (a p2sh-segwit wallet with bech32 change paying a p2sh address).
const path = require('path');
const { loadCase } = require('./lib/cases.js');
const { analyse } = require('./lib/evaluate.js');
const AN = require('../../public/js/hopline-analysis.js');
const { wilson } = require('./lib/stats.js');

const NAME = { p2pkh: 'legacy', p2sh: 'p2sh', v0_p2wpkh: 'p2wpkh', v1_p2tr: 'taproot', v0_p2wsh: 'p2wsh' };
const pc = (k, n) => (n ? Math.round(100 * k / n) + '% (' + k + ' of ' + n + ')' : '-');
const ci = (k, n) => { if (!n) return ''; const w = wilson(k, n); return ' [' + Math.round(100 * w.lo) + '-' + Math.round(100 * w.hi) + ']'; };
const blank = () => ({ txs: 0, guessed: 0, right: 0, typeAlone: 0, typeAloneRight: 0, high: 0, highRight: 0, medium: 0, mediumRight: 0, low: 0, lowRight: 0, wrong: [] });

const byRecipient = {}, byBoth = {};
let skippedBatches = 0, noChange = 0, noChangeGuessed = 0;
const rowOf = (table, key) => (table[key] = table[key] || blank());

process.argv.slice(2).forEach((dir) => {
  const c = loadCase(path.resolve(dir)), an = analyse(c);
  const byId = new Map(c.txs.map((t) => [t.txid, t]));
  Object.keys(c.truth.txs).forEach((txid) => {
    const t = c.truth.txs[txid];
    if (t.kind !== 'payment') return;
    const raw = byId.get(txid), rec = an.tx.get('tx:' + txid), v = AN.txView(c.graph, 'tx:' + txid);
    if (!raw || !v || !v.complete) return;
    if (t.change_vout == null) { noChange++; if (rec && rec.change) noChangeGuessed++; return; }
    const pay = raw.vout.map((o, i) => ({ i, o })).filter((x) => x.i !== t.change_vout && x.o.scriptpubkey_type !== 'op_return');
    if (pay.length !== 1) { skippedBatches++; return; }
    const inType = Array.from(new Set(raw.vin.map((x) => NAME[x.prevout.scriptpubkey_type] || x.prevout.scriptpubkey_type))).join('+');
    const rcType = NAME[pay[0].o.scriptpubkey_type] || pay[0].o.scriptpubkey_type;
    [rowOf(byRecipient, rcType), rowOf(byRecipient, 'ALL'), rowOf(byBoth, 'in ' + inType + ' -> pay ' + rcType)].forEach((r) => {
      r.txs++;
      const g = rec ? rec.change : null;
      if (!g) return;
      const ok = g.vout === t.change_vout, signs = Array.from(new Set(g.reasons.map(AN.signalOf)));
      r.guessed++; if (ok) r.right++;
      if (signs.length === 1 && signs[0] === 'type') { r.typeAlone++; if (ok) r.typeAloneRight++; }
      r[g.confidence]++; if (ok) r[g.confidence + 'Right']++;
      if (!ok) r.wrong.push(g.confidence + ':' + signs.join('+'));
    });
  });
});

const order = (a, b) => (a === 'ALL') - (b === 'ALL') || a.localeCompare(b);
console.log('Change guess by the type of the recipient (transactions with one payment and a known change)\n');
console.log('recipient  txs   guessed        right                    "type alone"      high            medium           low');
Object.keys(byRecipient).sort(order).forEach((k) => {
  const r = byRecipient[k];
  console.log(k.padEnd(9), String(r.txs).padStart(4), pc(r.guessed, r.txs).padEnd(14), (pc(r.right, r.guessed) + ci(r.right, r.guessed)).padEnd(24), pc(r.typeAloneRight, r.typeAlone).padEnd(16), pc(r.highRight, r.high).padEnd(16), pc(r.mediumRight, r.medium).padEnd(16), pc(r.lowRight, r.low));
});
console.log('\nBy the type of the coins spent and the type of the recipient\n');
console.log('inputs -> recipient'.padEnd(28), 'txs  guessed  right  type-alone-right  wrong guesses (label:signs)');
Object.keys(byBoth).sort().forEach((k) => {
  const r = byBoth[k];
  console.log(k.padEnd(28), String(r.txs).padStart(3), String(r.guessed).padStart(7), (r.right + '/' + r.guessed).padStart(6), (r.typeAloneRight + '/' + r.typeAlone).padStart(12), '    ', r.wrong.join(', '));
});
console.log('\ntransactions with no change output: ' + noChange + ', of which a guess was made (always wrong): ' + noChangeGuessed + '; more than one payment (batches) left out: ' + skippedBatches);
