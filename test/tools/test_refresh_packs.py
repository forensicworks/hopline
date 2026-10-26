"""tools/build_packs.py --refresh: every source is downloaded again and rebuilt on its own, a failure keeps the old files, and what changed is written out safely.

Nothing here touches the network: the two downloads are replaced by files built in the test.
"""
import hashlib
import io
import json
import pathlib
import re
import sys

import pytest

from test_ofac_pack import BECH, ENTRIES, LEGACY, entry, sdn_xml, valid_address
from test_ransomwhere_pack import P2SH, data_of, row
from test_uksanctions_pack import designation, uk_xml

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import build_packs as bp  # noqa: E402
import make_label_pack_graphsense as gs  # noqa: E402
import make_label_pack_miningpools as mp  # noqa: E402
import make_label_pack_ransomwhere as rw  # noqa: E402
import make_label_pack_uksanctions as uk  # noqa: E402

FIVE = [BECH, LEGACY, "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"]


def ofac_xml(addresses, date="10/21/2026", name="GROUP"):
    return sdn_xml([entry(1000 + i, "%s %d" % (name, i), programs=["CYBER2"], ids=[("Digital Currency Address - XBT", a)]) for i, a in enumerate(addresses)], date).encode("utf-8")


def graphsense_files():
    """One small pack for each of the packs that are chosen, each with a source link of the kind its pack is chosen for."""
    return {name: chr(10).join(["title: T", "label: L", "currency: BTC", "source: " + prefixes[0] + "x", "tags:", "- address: " + valid_address(100 + i), ""])
            for i, (name, prefixes) in enumerate(gs.PACKS.items())}


@pytest.fixture
def world(monkeypatch):
    """The two sources as the test sets them: world.ofac and world.rw are the bytes the 'download' returns; world.note is what the Ransomwhere check says."""
    class W:
        ofac = ofac_xml(FIVE)
        rw = data_of([row(LEGACY, "Conti", [(1650000000, 150000000)]), row(P2SH, "Locky")])
        pools = json.dumps([{"id": 1, "name": "AntPool", "addresses": [FIVE[2]], "tags": ["/x/"], "link": "https://www.antpool.com"}]).encode("utf-8")
        gs = graphsense_files()
        uk = uk_xml([designation("RUS1421", "GARANTEX EUROPE OU", other="Digital Currency Address: XBT " + P2SH)])
        note = ""
        failing = set()
    w = W()

    def get_ofac(url):
        if "ofac-sdn" in w.failing:
            raise OSError("offline")
        return w.ofac

    def get_rw():
        if "ransomwhere" in w.failing:
            raise rw.ListError("Could not download it (offline).")
        return w.rw

    def get_mp():
        if "mining-pools" in w.failing:
            raise mp.ListError("Could not download the mining pools list (offline).")
        return w.pools, {"sha": "c" * 40, "date": "2026-09-24", "licence_text": "MIT License" + chr(10)}

    def get_gs():
        if "graphsense" in w.failing:
            raise gs.ListError("Could not download the GraphSense tag packs (offline).")
        return w.gs, {"sha": "f" * 40, "date": "2026-10-21", "licence_text": "MIT License" + chr(10)}

    def get_uk():
        if "uk-sanctions" in w.failing:
            raise OSError("offline")
        return w.uk

    monkeypatch.setattr(bp.gs, "fetch", get_gs)
    monkeypatch.setattr(uk, "MIN_DESIGNATIONS", 1)
    monkeypatch.setattr(bp.uk, "download", get_uk)
    monkeypatch.setattr(bp.ofac, "download", get_ofac)
    monkeypatch.setattr(bp.mp, "fetch", get_mp)
    monkeypatch.setattr(bp.rw, "download", get_rw)
    monkeypatch.setitem({s["id"]: s for s in bp.SOURCES}["ransomwhere"], "check", lambda: w.note)
    monkeypatch.setitem(rw.RELEASE, "md5", hashlib.md5(w.rw).hexdigest())
    w.set_rw = lambda data: (setattr(w, "rw", data), monkeypatch.setitem(rw.RELEASE, "md5", hashlib.md5(data).hexdigest()))
    return w


def run(tmp_path, *args):
    return bp.main(["--out", str(tmp_path / "packs"), *args])


def test_refresh_builds_every_source_and_a_second_refresh_changes_nothing(tmp_path, world, capsys):
    run(tmp_path, "--refresh", "--summary", str(tmp_path / "s.md"))
    out = capsys.readouterr().out
    assert "OFAC SDN list (Bitcoin): 5 wallets, as of 2026-10-21, written (+5 added)" in out and "Ransomwhere ransomware payments: 2 wallets, as of 2024-10-27, written (+2 added)" in out
    assert [e["id"] for e in bp.read_index(str(tmp_path / "packs" / "index.js"))] == ["ofac-sdn", "ransomwhere", "mining-pools", "uk-sanctions", "graphsense"]
    before = {p.name: p.read_bytes() for p in (tmp_path / "packs").iterdir()}
    run(tmp_path, "--refresh", "--summary", str(tmp_path / "s2.md"))
    out2 = capsys.readouterr().out
    assert out2.count("unchanged") == 5 and "(+" not in out2 and "(-" not in out2
    assert {p.name: p.read_bytes() for p in (tmp_path / "packs").iterdir()} == before, "the same sources give the same files, byte for byte"
    assert "| `OFAC SDN list (Bitcoin)` | 5 | 2026-10-21 | nothing |" in (tmp_path / "s2.md").read_text(encoding="utf-8")


def test_a_changed_list_is_summarised_by_the_wallets_added_removed_and_renamed(tmp_path, world, capsys):
    run(tmp_path, "--refresh")
    world.ofac = sdn_xml([entry(1000, "GROUP 0 RENAMED", programs=["CYBER2"], ids=[("Digital Currency Address - XBT", FIVE[0])])]
                         + [entry(1000 + i, "GROUP %d" % i, programs=["CYBER2"], ids=[("Digital Currency Address - XBT", a)]) for i, a in enumerate(FIVE) if i in (1, 2, 3)]
                         + [entry(2000, "NEW GROUP", programs=["DPRK3"], ids=[("Digital Currency Address - XBT", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2")])], "10/28/2026").encode("utf-8")
    capsys.readouterr()
    run(tmp_path, "--refresh", "--summary", str(tmp_path / "s.md"))
    assert "5 wallets, as of 2026-10-28, written (+1 added, -1 removed, 1 renamed)" in capsys.readouterr().out
    text = (tmp_path / "s.md").read_text(encoding="utf-8")
    assert "### ofac-sdn: added (1)" in text and "`1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2` `OFAC SDN: NEW GROUP`" in text
    assert "### ofac-sdn: removed (1)" in text and "`%s` `OFAC SDN: GROUP 4`" % FIVE[4] in text
    assert "### ofac-sdn: renamed (1)" in text and "`OFAC SDN: GROUP 0 RENAMED` (was `OFAC SDN: GROUP 0`)" in text
    assert "### ransomwhere" not in text, "an unchanged pack lists nothing"


def test_one_source_that_fails_keeps_its_files_and_the_others_are_still_refreshed(tmp_path, world, capsys):
    run(tmp_path, "--refresh")
    packs = tmp_path / "packs"
    ransom_before = (packs / "ransomwhere.js").read_bytes()
    world.failing = {"ransomwhere"}
    world.ofac = ofac_xml(FIVE + ["1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"], "10/28/2026")
    capsys.readouterr()
    with pytest.raises(SystemExit) as e:
        run(tmp_path, "--refresh", "--summary", str(tmp_path / "s.md"))
    assert e.value.code == 1
    cap = capsys.readouterr()
    assert "OFAC SDN list (Bitcoin): 6 wallets, as of 2026-10-28, written" in cap.out and "ransomwhere: NOT refreshed: Could not download it (offline)." in cap.err
    assert (packs / "ransomwhere.js").read_bytes() == ransom_before and [e["id"] for e in bp.read_index(str(packs / "index.js"))] == ["ofac-sdn", "ransomwhere", "mining-pools", "uk-sanctions", "graphsense"]
    text = (tmp_path / "s.md").read_text(encoding="utf-8")
    assert "### Could not refresh" in text and "**ransomwhere**" in text and "its files were left as they were" in text


def test_the_mining_pools_are_refreshed_with_their_commit_and_one_that_fails_is_only_that_one(tmp_path, world, capsys):
    run(tmp_path, "--refresh")
    out = capsys.readouterr().out
    assert "Mining pools (mempool.space): 1 wallets, as of 2026-09-24, written (+1 added)" in out
    (e,) = [x for x in bp.read_index(str(tmp_path / "packs" / "index.js")) if x["id"] == "mining-pools"]
    assert e["defaultOn"] is False and e["licence"] == "MIT" and "commit ccccccc" in e["source"]
    before = (tmp_path / "packs" / "mining-pools.js").read_bytes()
    world.failing = {"mining-pools"}
    with pytest.raises(SystemExit) as ex:
        run(tmp_path, "--refresh")
    assert ex.value.code == 1 and "mining-pools: NOT refreshed: Could not download the mining pools list (offline)." in capsys.readouterr().err
    assert (tmp_path / "packs" / "mining-pools.js").read_bytes() == before


def test_the_uk_list_ships_on_as_a_sanctions_list_and_losing_an_address_is_a_delisting_not_a_mistake(tmp_path, world, capsys):
    run(tmp_path, "--refresh")
    (e,) = [x for x in bp.read_index(str(tmp_path / "packs" / "index.js")) if x["id"] == "uk-sanctions"]
    assert (e["sanctions"], e["defaultOn"], e["entries"], e["asOf"]) == (True, True, 1, "2026-10-16")
    world.uk = uk_xml([designation("RUS1421", "GARANTEX EUROPE OU", other="nothing now"), designation("RUS9", "OTHER", other="Digital address: " + P2SH)], "23/10/2026")
    capsys.readouterr()
    run(tmp_path, "--refresh", "--only", "uk-sanctions", "--summary", str(tmp_path / "s.md"))
    text = (tmp_path / "s.md").read_text(encoding="utf-8")
    assert "### uk-sanctions: renamed (1)" in text and "`UK Sanctions: OTHER` (was `UK Sanctions: GARANTEX EUROPE OU`)" in text
    world.failing = {"uk-sanctions"}
    before = (tmp_path / "packs" / "uk-sanctions.js").read_bytes()
    with pytest.raises(SystemExit):
        run(tmp_path, "--refresh", "--only", "uk-sanctions")
    assert "uk-sanctions: NOT refreshed" in capsys.readouterr().err and (tmp_path / "packs" / "uk-sanctions.js").read_bytes() == before


def test_a_list_that_suddenly_shrinks_is_refused_but_only_that_source(tmp_path, world, capsys):
    many = [valid_address(i) for i in range(25)]
    world.ofac = ofac_xml(many)
    run(tmp_path, "--refresh")
    before = (tmp_path / "packs" / "ofac-sdn.js").read_bytes()
    world.ofac = ofac_xml(many[:2], "10/28/2026")
    with pytest.raises(SystemExit):
        run(tmp_path, "--refresh")
    assert "would shrink from 25 to 2" in capsys.readouterr().err and (tmp_path / "packs" / "ofac-sdn.js").read_bytes() == before


def test_a_source_that_has_not_been_written_before_is_added_and_one_that_is_off_stays_off(tmp_path, world):
    run(tmp_path, "--refresh", "--only", "ransomwhere")
    assert [(e["id"], e["defaultOn"]) for e in bp.read_index(str(tmp_path / "packs" / "index.js"))] == [("ransomwhere", False)]
    run(tmp_path, "--refresh", "--only", "ofac-sdn")
    assert [(e["id"], e["defaultOn"]) for e in bp.read_index(str(tmp_path / "packs" / "index.js"))] == [("ransomwhere", False), ("ofac-sdn", True)], "the others are left as they were"


def test_a_newer_release_is_reported_for_a_person_and_changes_nothing(tmp_path, world, capsys):
    world.note = "Ransomwhere has a newer release on Zenodo: version 2.0.0."
    run(tmp_path, "--refresh", "--summary", str(tmp_path / "s.md"))
    assert "ransomwhere: Ransomwhere has a newer release on Zenodo: version 2.0.0." in capsys.readouterr().out
    assert "### Needs a decision" in (tmp_path / "s.md").read_text(encoding="utf-8") and "version 2.0.0" in (tmp_path / "s.md").read_text(encoding="utf-8")
    assert bp.read_index(str(tmp_path / "packs" / "index.js"))[1]["asOf"] == "2024-10-27", "the pack stayed on the pinned release"


def test_text_from_a_source_cannot_become_a_link_a_mention_or_markup_in_the_summary(tmp_path, world):
    evil = "@everyone [click](http://x.example) ![i](http://y.example) <img src=x onerror=1>" + chr(96) + chr(10) + "# heading"
    world.ofac = sdn_xml([entry(1, evil, programs=["CYBER2"], ids=[("Digital Currency Address - XBT", a)]) for a in FIVE]).encode("utf-8")
    run(tmp_path, "--refresh", "--only", "ofac-sdn", "--summary", str(tmp_path / "s.md"))
    text = (tmp_path / "s.md").read_text(encoding="utf-8")
    outside = re.sub(r"`[^`\n]*`", "", text)
    assert "@" not in outside and "](" not in outside and "<" not in outside and "!" not in outside.replace("###", ""), outside
    assert all(not ln.startswith("# ") for ln in text.splitlines()), "no line the source wrote became a heading"
    assert text.count(chr(10) + "- `") == 5


def test_arguments_are_checked(tmp_path, world):
    for argv in (["--only", "ofac-sdn"], ["--refresh", "--only", "nope"], ["--refresh", "--download"], ["--refresh", "--ransomwhere", "x"]):
        with pytest.raises(SystemExit) as e:
            run(tmp_path, *argv)
        assert e.value.code == 2, argv
    assert not (tmp_path / "packs").exists()


# ---- the release check -------------------------------------------------------------------------------------------------------
class Reply(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *a): return False


def serve(monkeypatch, body):
    seen = []
    monkeypatch.setattr(rw.urllib.request, "urlopen", lambda url, timeout=0: (seen.append(url), Reply(body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")))[1])
    return seen


def test_the_release_check_is_silent_for_the_pinned_release_and_speaks_for_a_newer_one(monkeypatch):
    seen = serve(monkeypatch, {"id": 13999026, "metadata": {"version": "1.1.0", "publication_date": "2024-10-27", "license": {"id": "cc-by-4.0"}}})
    assert rw.newer_release() == "" and seen == ["https://zenodo.org/api/records/13999026/versions/latest"]
    serve(monkeypatch, {"id": 20000001, "metadata": {"version": "2.0.0", "publication_date": "2026-11-02", "license": {"id": "cc-by-nc-4.0"}}})
    said = rw.newer_release()
    assert "version 2.0.0, published 2026-11-02, licence cc-by-nc-4.0, https://zenodo.org/records/20000001" in said and "unchanged until" in said


@pytest.mark.parametrize("body", [b"", b"not json", b"[]", b"{}", b'{"id": "x; rm -rf"}', b'{"id": 5, "metadata": 7}'])
def test_the_release_check_never_raises_on_a_reply_it_does_not_understand(monkeypatch, body):
    serve(monkeypatch, body)
    said = rw.newer_release()
    assert said == "" or ("licence ?" in said and "records/5" in said)


def test_the_release_check_says_nothing_when_it_cannot_run(monkeypatch):
    def boom(url, timeout=0):
        raise OSError("offline")
    monkeypatch.setattr(rw.urllib.request, "urlopen", boom)
    assert rw.newer_release() == ""


# ---- the workflow ------------------------------------------------------------------------------------------------------------
WORKFLOW = (ROOT / ".github" / "workflows" / "refresh-packs.yml").read_text(encoding="utf-8")


def test_the_workflow_runs_weekly_with_only_the_rights_it_needs_and_only_first_party_actions():
    assert re.search(r"schedule:\s*\n\s*- cron: '\d+ \d+ \* \* 1'", WORKFLOW) and "workflow_dispatch:" in WORKFLOW
    perms = re.search(r"^permissions:\n((?:  .*\n)+)", WORKFLOW, re.M).group(1)
    assert sorted(x.strip() for x in perms.splitlines()) == ["contents: write", "pull-requests: write"]
    assert "pull_request_target" not in WORKFLOW and "secrets." not in WORKFLOW, "no secrets: it uses the run's own token"
    assert all(u.startswith("actions/") for u in re.findall(r"uses: (\S+)", WORKFLOW)), "no third-party action can run with write rights"
    assert "tools/build_packs.py --refresh --summary" in WORKFLOW and "automation/refresh-packs" in WORKFLOW
    assert re.findall(r"GITHUB_TOKEN: (.*?)\s{2,}#", WORKFLOW) == ["${{ github.token }}"], "the run's own token, handed to the download step only"
    assert WORKFLOW.count("github.token") == 2 and WORKFLOW.index("GITHUB_TOKEN:") < WORKFLOW.index("What changed"), "(the other use is the pull request step)"


def test_the_workflow_never_pushes_to_the_default_branch_and_tests_before_it_proposes():
    pushes = re.findall(r"git push[^\n]*", WORKFLOW)
    assert pushes == ['git push --force origin "$BRANCH"'] and "BRANCH: automation/refresh-packs" in WORKFLOW
    assert WORKFLOW.index("Unit tests") < WORKFLOW.index("Open or update the pull request") and WORKFLOW.index("Tool tests") < WORKFLOW.index("Open or update the pull request")
    assert "steps.build.outcome == 'failure'" in WORKFLOW, "a source that could not be refreshed fails the run, so GitHub tells you"
