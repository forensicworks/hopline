'use strict';
/**
 * Three small cases made by hand, in memory, with answers worked out on paper: they test the benchmark itself (the counting, the
 * intervals, the way a case is read) apart from anything a generator makes.
 */
const { buildGraph } = require('./cases.js');

const hex = (n) => ('0' + n.toString(16)).slice(-2).repeat(32);
const addr = (name) => 'bc1q' + name.padEnd(20, 'x');
const IN = (txid, vout, address, value, type) => ({ txid, vout, address, value, type });
const OUT = (address, value, type) => ({ address, value, type });

function tx(n, ins, outs) {
  return {
    txid: hex(n), version: 2, locktime: 0, size: 220, weight: 880, fee: 200,
    status: { confirmed: true, block_height: 1000 + n, block_time: 1700000000 + n * 600 },
    vin: ins.map((i) => ({ txid: i.txid, vout: i.vout, is_coinbase: false, sequence: 4294967293, prevout: { scriptpubkey_address: i.address, scriptpubkey_type: i.type || 'v0_p2wpkh', value: i.value } })),
    vout: outs.map((o) => ({ scriptpubkey_address: o.address, scriptpubkey_type: o.type || 'v0_p2wpkh', value: o.value }))
  };
}

function make(name, txs, truth) {
  return { name, meta: { name }, txs, truth: Object.assign({ schema: 1, wallets: {}, owners: {}, txs: {}, chains: [], known: [] }, truth), graph: buildGraph(txs), files: {} };
}

/** Five payments from one wallet: a high guess that is right, a medium that is right, an even split nothing is said about, a medium that is wrong, and a payment with no change that gets a guess. */
function changeCase() {
  const t = [
    tx(1, [IN(hex(90), 0, addr('a1'), 100000, 'p2pkh')], [OUT(addr('shop'), 60000, 'p2pkh'), OUT(addr('a1'), 39000, 'p2pkh')]),
    tx(2, [IN(hex(91), 0, addr('a2'), 100000)], [OUT(addr('legacy'), 61234, 'p2pkh'), OUT(addr('mine'), 38000)]),
    tx(3, [IN(hex(92), 0, addr('a3'), 100000)], [OUT(addr('x1'), 50000), OUT(addr('x2'), 49990)]),
    tx(4, [IN(hex(93), 0, addr('a4'), 100000)], [OUT(addr('oldchange'), 38000, 'p2pkh'), OUT(addr('payee'), 61234)]),
    tx(5, [IN(hex(94), 0, addr('a5'), 100000)], [OUT(addr('exact'), 60000, 'p2pkh'), OUT(addr('payee2'), 39800)])
  ];
  const truth = { wallets: { w1: { software: 'test', behaviour: { change_position: 'random', address_type: 'bech32', change_type: 'bech32', round_payments: 0 } } },
                  txs: {} };
  const changes = [1, 1, 0, 0, null];
  t.forEach((x, i) => { truth.txs[x.txid] = { kind: 'payment', wallet: 'w1', change_vout: changes[i] }; });
  return make('mini-change', t, truth);
}

/** A CoinJoin, an exchange paying three equal amounts from three of its own addresses (it looks like one), and an ordinary payment. */
function coinjoinCase() {
  const cj = tx(1, [IN(hex(90), 0, addr('p1'), 50000), IN(hex(91), 0, addr('p2'), 50000), IN(hex(92), 0, addr('p3'), 50000)],
                [OUT(addr('e1'), 40000), OUT(addr('e2'), 40000), OUT(addr('e3'), 40000), OUT(addr('c1'), 9000), OUT(addr('c2'), 9100), OUT(addr('c3'), 9200)]);
  const payout = tx(2, [IN(hex(93), 0, addr('x1'), 30000), IN(hex(94), 0, addr('x2'), 30000), IN(hex(95), 0, addr('x3'), 30000)], [OUT(addr('u1'), 25000), OUT(addr('u2'), 25000), OUT(addr('u3'), 25000)]);
  const pay = tx(3, [IN(hex(96), 0, addr('s1'), 100000)], [OUT(addr('r1'), 60000), OUT(addr('s1'), 39000)]);
  const owners = { [addr('p1')]: 'wa', [addr('p2')]: 'wb', [addr('p3')]: 'wc', [addr('x1')]: 'ex', [addr('x2')]: 'ex', [addr('x3')]: 'ex', [addr('s1')]: 'wd' };
  return make('mini-coinjoin', [cj, payout, pay], { owners, txs: { [cj.txid]: { kind: 'coinjoin' }, [payout.txid]: { kind: 'equal-payout', wallet: 'ex', change_vout: null }, [pay.txid]: { kind: 'payment', wallet: 'wd', change_vout: 1 } } });
}

/** A peel chain of five steps, and two ordinary payments that are not part of one. */
function peelCase() {
  const t = [];
  let prev = IN(hex(90), 0, addr('start'), 1000000);
  for (let i = 1; i <= 5; i++) {
    const left = prev.value - 10000 - 200, next = tx(i, [prev], [OUT(addr('peel' + i), 10000), OUT(addr('hold' + i), left)]);
    t.push(next); prev = IN(next.txid, 1, addr('hold' + i), left);
  }
  const o1 = tx(10, [IN(hex(91), 0, addr('o1'), 100000)], [OUT(addr('q1'), 10000), OUT(addr('o1b'), 89000)]);
  const o2 = tx(11, [IN(hex(92), 0, addr('o2'), 100000)], [OUT(addr('q2'), 20000), OUT(addr('o2b'), 79000)]);
  const truth = { chains: [t.map((x) => x.txid)], txs: {} };
  t.forEach((x) => { truth.txs[x.txid] = { kind: 'peel', wallet: 'w1', change_vout: 1 }; });
  [o1, o2].forEach((x) => { truth.txs[x.txid] = { kind: 'payment', wallet: 'w2', change_vout: 1 }; });
  return make('mini-peel', t.concat([o1, o2]), truth);
}

module.exports = { changeCase, coinjoinCase, peelCase, tx, hex, addr, make };
