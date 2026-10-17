"""tools/make_label_pack_ofac.py: the OFAC list becomes a label pack that Orion's importer accepts."""
import json
import pathlib
import subprocess
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools" / "make_label_pack_ofac.py"
BECH = "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h"      # real addresses with valid checksums
LEGACY = "325gSHHe7UGvzEc9kGx43VqPboXUVwa26i"

# sdn.csv has no header: ent_num, SDN_Name, SDN_Type, Program, Title, Call_Sign, Vess_type, Tonnage, GRT, Vess_flag, Vess_owner, Remarks
ROWS = [
    ['1', 'EXAMPLE GROUP', '-0-', 'CYBER2', '-0-', '-0-', '-0-', '-0-', '-0-', '-0-', '-0-', 'Digital Currency Address - XBT %s; alt. Digital Currency Address - XBT %s; Digital Currency Address - ETH 0x742d35Cc6634C0532925a3b844Bc454e4438f44e; website example.org' % (BECH, LEGACY)],
    ['2', 'ETH ONLY LTD', '-0-', 'SDGT', '-0-', '-0-', '-0-', '-0-', '-0-', '-0-', '-0-', 'Digital Currency Address - ETH 0x742d35Cc6634C0532925a3b844Bc454e4438f44e'],
    ['3', 'NO ADDRESS INC', '-0-', 'IRAN', '-0-', '-0-', '-0-', '-0-', '-0-', '-0-', '-0-', 'a.k.a. Something'],
    ['4', 'REPEAT GROUP', '-0-', 'CYBER2', '-0-', '-0-', '-0-', '-0-', '-0-', '-0-', '-0-', 'Digital Currency Address - XBT %s' % BECH],
    ['5', 'SHORT ROW'],
]


def write_sdn(path):
    import csv
    with open(path, "w", encoding="utf-8", newline="") as f:
        csv.writer(f, quoting=csv.QUOTE_ALL).writerows(ROWS)


def run(*args):
    return subprocess.run([sys.executable, "-I", str(SCRIPT), *args], capture_output=True, text=True, timeout=60)


def test_bitcoin_addresses_become_labels_and_everything_else_is_left_out(tmp_path):
    sdn, out = tmp_path / "sdn.csv", tmp_path / "pack.json"
    write_sdn(sdn)
    r = run("--sdn", str(sdn), "--out", str(out))
    assert r.returncode == 0 and "Wrote 2 Bitcoin addresses" in r.stdout, r.stderr
    pack = json.loads(out.read_text(encoding="utf-8"))
    assert pack["format"] == "orion-labels" and pack["name"] == "OFAC SDN list (Bitcoin)" and "OFAC SDN list" in pack["source"]
    assert [(e["address"], e["label"], e["category"]) for e in pack["labels"]] == [(BECH, "OFAC SDN: EXAMPLE GROUP", "CYBER2"), (LEGACY, "OFAC SDN: EXAMPLE GROUP", "CYBER2")], "the Ethereum address, the row without one and the repeat are left out"


def test_orions_own_importer_accepts_the_result(tmp_path):
    sdn, out = tmp_path / "sdn.csv", tmp_path / "pack.json"
    write_sdn(sdn); assert run("--sdn", str(sdn), "--out", str(out)).returncode == 0
    js = "const L = require(process.argv[1]); const p = L.parse(require('fs').readFileSync(process.argv[2], 'utf8'), 'x'); console.log(JSON.stringify([p.name, p.entries.length, p.skipped]));"
    r = subprocess.run(["node", "-e", js, str(ROOT / "public" / "js" / "orion-labels.js"), str(out)], capture_output=True, text=True, timeout=60)
    if r.returncode != 0 and "not found" in (r.stderr or "").lower():
        pytest.skip("node is not available")
    assert r.returncode == 0, r.stderr
    name, n, skipped = json.loads(r.stdout)
    assert name == "OFAC SDN list (Bitcoin)" and n == 2 and sum(skipped.values()) == 0


def test_a_file_that_is_not_the_sdn_list_is_refused(tmp_path):
    bad = tmp_path / "other.csv"; bad.write_text("a,b,c\n1,2,3\n", encoding="utf-8")
    r = run("--sdn", str(bad), "--out", str(tmp_path / "x.json"))
    assert r.returncode != 0 and "No Bitcoin addresses found" in r.stderr
    assert not (tmp_path / "x.json").exists()


def test_a_failed_download_says_what_to_do_and_writes_nothing(tmp_path):
    r = run("--download", "--url", "http://127.0.0.1:9/sdn.csv", "--out", str(tmp_path / "x.json"))
    assert r.returncode != 0 and "Download sdn.csv yourself and use --sdn" in r.stderr
    assert not (tmp_path / "x.json").exists()
