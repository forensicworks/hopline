"""sources.md says where every shipped list comes from: it names each one's source and licence, points at files that exist, and lists every converter."""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
DOC = (ROOT / "sources.md").read_text(encoding="utf-8")
INDEX = json.loads(re.search(r"window\.HOPLINE_PACK_INDEX = (\[.*\]);", (ROOT / "public" / "packs" / "index.js").read_text(encoding="utf-8"), re.S).group(1))


def test_each_shipped_list_has_its_source_and_its_licence_in_the_document():
    assert INDEX
    for p in INDEX:
        assert p["sourceUrl"] in DOC, "%s: its source address is not in sources.md" % p["id"]
        assert p["licence"] in DOC or p["licence"].split(" (")[0] in DOC, "%s: its licence (%s) is not in sources.md" % (p["id"], p["licence"])


def test_each_converter_and_each_pack_file_is_named_in_the_document_and_credited_in_notice():
    notice = (ROOT / "NOTICE").read_text(encoding="utf-8")
    for tool in sorted((ROOT / "tools").glob("make_label_pack_*.py")):
        assert "tools/" + tool.name in DOC, "%s is not in sources.md" % tool.name
    for p in INDEX:
        assert "public/packs/" + p["file"] in notice, "%s is not credited in NOTICE" % p["file"]


def test_every_link_to_a_file_in_the_repository_points_at_something_that_is_there():
    links = re.findall(r"\]\(([^)#\s]+)(?:#[^)]*)?\)", DOC)
    local = [l for l in links if not re.match(r"[a-z]+:", l)]
    assert local, "the document links to the files it names"
    missing = [l for l in local if not (ROOT / l).exists()]
    assert not missing, missing


def test_the_lists_it_says_are_on_by_default_are_the_ones_that_are():
    on = sorted(p["id"] for p in INDEX if p["defaultOn"])
    assert on == ["ofac-sdn", "uk-sanctions"], "sources.md says the two sanctions lists are on by default and the others off; change the document with the flags"
    assert all(p["sanctions"] for p in INDEX if p["defaultOn"]), "a list is on by default only when it is a sanctions list"
