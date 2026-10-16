"""Synthetic transactions for the analysis tests. The page cannot tell them from real ones: they are served by the same mocked API."""


def tid(n):
    return ("%02x" % n) * 32


def addr(name):
    """A readable fake address (lower case, so the page keeps it exactly as written)."""
    return "bc1q" + name.ljust(20, "x")


def IN(txn, vout, who, value, typ="v0_p2wpkh"):
    return {"txid": tid(txn), "vout": vout, "is_coinbase": False, "prevout": {"scriptpubkey_address": addr(who), "scriptpubkey_type": typ, "value": value}}


def OUT(who, value, typ="v0_p2wpkh"):
    return {"scriptpubkey_address": addr(who), "scriptpubkey_type": typ, "value": value}


def tx(mock, n, ins, outs, spent=None):
    """Serve transaction n and its outspends. `spent` maps an output index to the number of the transaction that spent it."""
    spent = spent or {}
    mock.routes["/tx/" + tid(n)] = {"txid": tid(n), "fee": 150, "weight": 800,
                                    "status": {"confirmed": True, "block_height": 700000 + n, "block_time": 1650000000 + n * 600}, "vin": ins, "vout": outs}
    mock.routes["/tx/" + tid(n) + "/outspends"] = [
        {"spent": True, "txid": tid(spent[i]), "vin": 0, "status": {"confirmed": True, "block_height": 700000 + spent[i], "block_time": 1650000000 + spent[i] * 600}} if i in spent else {"spent": False}
        for i in range(len(outs))]
    return "tx:" + tid(n)


def peel_chain(mock, length, first=10, value=1000000):
    """Transactions first .. first+length-1: each pays a small amount out of one coin and passes the rest to the next."""
    ids = []
    for i in range(length):
        n = first + i
        src = IN(5, 0, "origin", value) if i == 0 else IN(n - 1, 1, "c%d" % (n - 1), value)
        small, large = 1000 + i * 13, value - 1000 - i * 13 - 200
        ids.append(tx(mock, n, [src], [OUT("peel%d" % n, small), OUT("c%d" % n, large)], spent={1: n + 1} if i < length - 1 else {}))
        value = large
    return ids


def consolidation(mock, n=30, k=6):
    """k wallets gathered into one output: the common-input rule links the k wallets."""
    return tx(mock, n, [IN(80 + i, 0, "k%d" % i, 10000) for i in range(k)], [OUT("sink", 59000)])


def reuse_change(mock, n=40):
    """The sender paid someone and the change came back to the sender's own address."""
    return tx(mock, n, [IN(90, 0, "me", 100000, "p2pkh")], [OUT("shop", 60000, "p2pkh"), OUT("me", 39000, "p2pkh")])


def coinjoin(mock, n=50):
    ins = [IN(70 + i, 0, "w%d" % i, 1000000 + i * 777) for i in range(5)]
    outs = [OUT("e%d" % i, 1000000) for i in range(5)] + [OUT("cjchg1", 1234), OUT("cjchg2", 4321)]
    return tx(mock, n, ins, outs)


def unclear_change(mock, n=60):
    """Two outputs of the same type and similar size: nothing says which is the change."""
    ids = tx(mock, n, [IN(95, 0, "src", 100000)], [OUT("p60", 51234), OUT("q60", 48500)], spent={0: 61, 1: 62})
    tx(mock, 61, [IN(n, 0, "p60", 51234)], [OUT("r61", 50000)])
    tx(mock, 62, [IN(n, 1, "q60", 48500)], [OUT("r62", 47000)])
    return ids
