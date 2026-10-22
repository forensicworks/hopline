"""tools/verify_report.py: an untouched report passes; any change to it is found."""
import json
import pathlib
import re
import subprocess
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools" / "verify_report.py"

MAKE = r"""
const RP = require(process.argv[1]);
const tid = (n) => ('0' + n.toString(16)).slice(-2).repeat(32);
const nodes = [{ id: 'tx:' + tid(1), type: 'tx', txid: tid(1), loaded: true, confirmed: true, time: 1650000000, height: 700001, fee: 100, fetchedAt: 1700000000, source: 'https://x.example/api' },
               { id: 'addr:a', type: 'addr', address: 'a', received: 5000 }, { id: 'addr:b', type: 'addr', address: 'b', received: 4000 }];
const edges = [{ id: 'in:' + tid(1) + ':0', kind: 'in', source: 'addr:a', target: 'tx:' + tid(1), vin: 0, amount: 5000, txid: tid(1) },
               { id: 'out:' + tid(1) + ':0', kind: 'out', source: 'tx:' + tid(1), target: 'addr:b', vout: 0, amount: 4900, txid: tid(1), spent: false }];
RP.build({ title: 'T', generated: 1700000000000, nodes, edges, evidence: { format: 'hopline-workspace', nodes, edges, evidence: { generated: '2023-11-14T22:13:20Z', counts: { nodes: 3, edges: 2 } } }, analysis: null, known: () => null })
  .then((r) => { require('fs').writeFileSync(process.argv[2], r.html, 'utf8'); });
"""


def run(*args):
    return subprocess.run([sys.executable, "-I", str(SCRIPT), *args], capture_output=True, text=True, timeout=60)


@pytest.fixture
def report(tmp_path):
    out = tmp_path / "report.html"
    r = subprocess.run(["node", "-e", MAKE, str(ROOT / "public" / "js" / "hopline-report.js"), str(out)], capture_output=True, text=True, timeout=60)
    if r.returncode != 0 and "not found" in (r.stderr or "").lower():
        pytest.skip("node is not available")
    assert r.returncode == 0, r.stderr
    return out


def test_an_untouched_report_passes_and_its_evidence_can_be_extracted(report, tmp_path):
    r = run(str(report), "--extract", str(tmp_path / "ev.json"))
    assert r.returncode == 0 and "OK:" in r.stdout, r.stdout + r.stderr
    assert "stated SHA-256" in r.stdout and "actual SHA-256" in r.stdout and "stated document SHA-256" in r.stdout
    ev = json.loads((tmp_path / "ev.json").read_text(encoding="utf-8"))
    assert len(ev["nodes"]) == 3 and ev["evidence"]["counts"]["edges"] == 2


def test_a_report_made_before_the_rename_still_verifies(report, tmp_path):
    """Reports written when the project was called Orion name the evidence block "orion-evidence"."""
    import hashlib
    html = report.read_text(encoding="utf-8").replace('id="hopline-evidence"', 'id="orion-evidence"')
    zeroed = re.sub(r'(<p class="hash" id="document-hash">)[0-9a-f]{64}(</p>)', r"\g<1>" + "0" * 64 + r"\g<2>", html)
    old = tmp_path / "old-report.html"
    old.write_text(re.sub(r'(<p class="hash" id="document-hash">)[0-9a-f]{64}(</p>)', r"\g<1>" + hashlib.sha256(zeroed.encode("utf-8")).hexdigest() + r"\g<2>", html), encoding="utf-8", newline="")
    r = run(str(old))
    assert r.returncode == 0 and "OK:" in r.stdout, r.stdout + r.stderr


def test_changing_the_evidence_is_found(report):
    html = report.read_text(encoding="utf-8")
    report.write_text(html.replace('"amount":4900', '"amount":4000'), encoding="utf-8", newline="")
    r = run(str(report))
    assert r.returncode == 1 and "does not match the stated hash" in r.stderr


def test_changing_a_word_of_the_readable_report_is_found(report):
    html = report.read_text(encoding="utf-8")
    assert "unspent" in html
    report.write_text(html.replace("unspent", "spent  "), encoding="utf-8", newline="")
    r = run(str(report))
    assert r.returncode == 1 and "document hash" in r.stderr and "does not match the stated hash" not in r.stderr, "the evidence is intact, the readable part is not"


def test_resaving_with_other_line_endings_is_found(report):
    html = report.read_text(encoding="utf-8")
    report.write_bytes(html.replace("\n", "\r\n").encode("utf-8"))
    r = run(str(report))
    assert r.returncode == 1 and "document hash" in r.stderr


def test_a_fake_transaction_added_to_the_readable_part_is_found(report):
    html = report.read_text(encoding="utf-8")
    fake = '<section class="tx" id="tx-' + "ab" * 32 + '"></section>'
    report.write_text(html.replace("<h2>Wallets</h2>", fake + "<h2>Wallets</h2>"), encoding="utf-8", newline="")
    r = run(str(report))
    assert r.returncode == 1 and "not in the evidence" in r.stderr


def test_a_changed_stated_hash_and_a_broken_file_are_found(report, tmp_path):
    html = report.read_text(encoding="utf-8")
    h = re.search(r'id="evidence-hash">([0-9a-f]{64})<', html).group(1)
    report.write_text(html.replace(h, "0" * 64, 1), encoding="utf-8", newline="")
    assert run(str(report)).returncode == 1
    junk = tmp_path / "junk.html"; junk.write_text("<html>not a report</html>", encoding="utf-8")
    r = run(str(junk))
    assert r.returncode == 1 and "evidence block" in r.stderr
