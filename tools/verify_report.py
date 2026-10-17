#!/usr/bin/env python3
"""Check an Orion investigation report: was it changed after it was made?

    python tools/verify_report.py report.html
    python tools/verify_report.py report.html --extract evidence.json

An Orion report embeds its evidence (every vertex and movement it describes, where and when each transaction was fetched,
the settings used) as a JSON block and states two SHA-256 hashes: one of that block's text, one of the whole file (with the
document hash itself written as 64 zeros). This script recomputes both, checks that the JSON reads, that its counts add up,
and that every transaction listed in the readable part of the report is in the evidence. Exit status 0 = nothing wrong
found, 1 = a problem. A change to a single word of the readable part, or re-saving the file with other line endings,
changes the document hash.

It proves the file matches what Orion wrote, not that Orion's data source told the truth: for that, compare against the
blockchain yourself (the report names the source and the time each transaction was fetched).
"""
import argparse
import hashlib
import json
import re
import sys

BLOCK = re.compile(r'<script type="application/json" id="orion-evidence">(.*?)</script>', re.S)
STATED = re.compile(r'<p class="hash" id="evidence-hash">([0-9a-f]{64})</p>')
DOC = re.compile(r'(<p class="hash" id="document-hash">)([0-9a-f]{64})(</p>)')
TX_ANCHOR = re.compile(r'<section class="tx" id="tx-([0-9a-f]{64})">')


def verify(html):
    """Return (problems, facts): two lists of strings."""
    problems, facts = [], []
    blocks, stated = BLOCK.findall(html), STATED.findall(html)
    if len(blocks) != 1:
        return ["expected exactly one evidence block, found %d" % len(blocks)], facts
    if len(stated) != 1:
        return ["expected exactly one stated hash, found %d" % len(stated)], facts
    text = blocks[0]
    actual = hashlib.sha256(text.encode("utf-8")).hexdigest()
    facts.append("stated SHA-256: " + stated[0])
    facts.append("actual SHA-256: " + actual)
    if actual != stated[0]:
        problems.append("the evidence block does not match the stated hash: the file was changed after it was made")
    docs = DOC.findall(html)
    if len(docs) != 1:
        problems.append("expected exactly one document hash, found %d" % len(docs))
    else:
        zeroed = DOC.sub(lambda m: m.group(1) + "0" * 64 + m.group(3), html, count=1)
        doc_actual = hashlib.sha256(zeroed.encode("utf-8")).hexdigest()
        facts.append("stated document SHA-256: " + docs[0][1])
        facts.append("actual document SHA-256: " + doc_actual)
        if doc_actual != docs[0][1]:
            problems.append("the file does not match its document hash: something in it was changed after it was made (or it was re-saved with other line endings)")
    try:
        data = json.loads(text)
    except ValueError as e:
        problems.append("the evidence block is not valid JSON (%s)" % e)
        return problems, facts
    nodes, edges = data.get("nodes") or [], data.get("edges") or []
    info = data.get("evidence") or {}
    counts = info.get("counts") or {}
    facts.append("evidence: %d vertices, %d movements, generated %s" % (len(nodes), len(edges), info.get("generated", "unknown")))
    if counts.get("nodes") != len(nodes) or counts.get("edges") != len(edges):
        problems.append("the counts recorded in the evidence (%s vertices, %s movements) do not match its content (%d, %d)" % (counts.get("nodes"), counts.get("edges"), len(nodes), len(edges)))
    txids = {n.get("txid") for n in nodes if n.get("type") == "tx"}
    listed = TX_ANCHOR.findall(html)
    stray = [t for t in listed if t not in txids]
    facts.append("transactions listed in the report: %d" % len(listed))
    if stray:
        problems.append("%d transaction(s) are listed in the report but are not in the evidence, e.g. %s" % (len(stray), stray[0]))
    fetched = [n.get("fetchedAt") for n in nodes if n.get("type") == "tx" and n.get("fetchedAt") is not None]
    if fetched:
        facts.append("transactions fetched between unix %d and %d" % (min(fetched), max(fetched)))
    return problems, facts


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("report", help="the report (.html)")
    ap.add_argument("--extract", metavar="FILE", help="also write the embedded evidence to FILE (a workspace file Orion can import)")
    a = ap.parse_args(argv)
    with open(a.report, encoding="utf-8", newline="") as f:
        html = f.read()
    problems, facts = verify(html)
    for line in facts:
        print(line)
    if a.extract and not problems:
        with open(a.extract, "w", encoding="utf-8", newline="") as f:
            f.write(json.dumps(json.loads(BLOCK.findall(html)[0]), indent=1))
        print("evidence written to " + a.extract)
    for p in problems:
        print("PROBLEM: " + p, file=sys.stderr)
    print("OK: the report matches the evidence it states." if not problems else "NOT OK")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
