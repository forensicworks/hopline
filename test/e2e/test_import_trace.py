"""Importing a workspace file into a workspace that already shows a trace: the file's trace is added below the current one, so something happens on screen."""
import json
import re

import pytest

from chains import peel_chain, tid
from conftest import NORMAL, PAGE_URL
from helpers import idle, open_query, settle

NORMAL_ID = "tx:" + NORMAL["txid"]
STATE = "window.__hopline.state"


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def fresh_page(browser, mock, errors):
    """A page of its own (its own browser storage: nothing is restored from another one)."""
    c = browser.new_context(viewport={"width": 1400, "height": 850}, accept_downloads=True)
    c.route(re.compile(r"^https?://[^/]+/api/"), mock.handle)
    p = c.new_page(); p.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    p.goto(PAGE_URL); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    return c, p


def export_json(page, path):
    page.click("summary:has-text('Export')")
    with page.expect_download() as d:
        page.click("[data-export=json]")
    d.value.save_as(str(path))


def outputs_of(page, tx_id):
    return page.evaluate("(id) => [...%s.graph.edges.values()].filter(e => e.source === id && e.kind === 'out').map(e => e.target)" % STATE, tx_id)


def make_group(page, tx_id):
    ids = outputs_of(page, tx_id)
    assert len(ids) >= 2
    gid = page.evaluate("(a) => window.__hopline.traceMakeGroup(a[0], 'next', a[1], { kind: 'picked' })", [tx_id, ids]); settle(page)
    assert gid
    return gid, ids


def facts(page):
    return page.evaluate("""() => { const s = window.__hopline.state, t = s.trace;
        return { loaded: s.graph.nodes.size, shown: [...t.shown], seeds: t.seeds.slice(), seed: t.seed, pos: Object.fromEntries([...t.pos].map(([k, v]) => [k, [v.x, v.y]])),
                 groups: [...t.groups.values()].map(g => ({ id: g.id, anchor: g.anchor, members: g.members.slice() })),
                 visible: window.__hopline.renderer.data.visible.nodes.size, toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent,
                 counts: document.getElementById('counts').textContent }; }""")


def exported_chain(browser, mock, errors, path, group=False):
    peel_chain(mock, 6)
    c, a = fresh_page(browser, mock, errors)
    open_query(a, tid(10))
    if group:
        make_group(a, "tx:" + tid(10))
    else:
        a.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: 3, follow: 'all' })", "tx:" + tid(10)); idle(a); settle(a)
    want = facts(a)
    export_json(a, path)
    c.close()
    return want


def sample_page(browser, mock, errors):
    c, p = fresh_page(browser, mock, errors)
    p.click("#sample"); idle(p); settle(p)
    return c, p


def import_file(page, path):
    page.set_input_files("#fileImport", str(path)); page.wait_for_timeout(900); settle(page)


def test_the_trace_in_the_file_is_added_below_the_one_on_screen(browser, mock, errors, tmp_path):
    f = tmp_path / "chain.json"
    want = exported_chain(browser, mock, errors, f)
    c, p = sample_page(browser, mock, errors)
    before = facts(p)
    assert len(before["shown"]) == 1
    import_file(p, f)
    after = facts(p)
    assert set(after["shown"]) == set(before["shown"]) | set(want["shown"]), "everything the file's trace showed is on screen now, and what was there stays"
    assert after["visible"] == len(after["shown"]) == 1 + len(want["shown"]), after
    assert after["loaded"] > before["loaded"] + len(want["shown"]) - 1
    assert after["pos"][NORMAL_ID] == before["pos"][NORMAL_ID], "what was on screen did not move"
    new_y = [after["pos"][i][1] for i in want["shown"]]
    assert min(new_y) > before["pos"][NORMAL_ID][1] + 100, "the imported trace sits below the current one: %r" % new_y
    assert after["seeds"][0] == before["seed"] and want["seed"] in after["seeds"], "the file's starting point is another starting point, the first one stays first"
    assert "Its trace (%d vertices) is shown below the current one." % len(want["shown"]) in after["toast"], after["toast"]
    assert "%d shown" % len(after["shown"]) in after["counts"]
    c.close()


def test_undo_load_takes_the_added_trace_back(browser, mock, errors, tmp_path):
    f = tmp_path / "chain.json"
    exported_chain(browser, mock, errors, f)
    c, p = sample_page(browser, mock, errors)
    before = facts(p)
    import_file(p, f)
    assert len(facts(p)["shown"]) > 1
    p.click("#btnUndoLoad"); settle(p)
    back = facts(p)
    assert back["shown"] == before["shown"] and back["loaded"] == before["loaded"], back
    c.close()


def test_a_file_whose_vertices_are_all_on_screen_adds_nothing_and_moves_nothing(browser, mock, errors, tmp_path):
    c, p = sample_page(browser, mock, errors)
    f = tmp_path / "sample.json"
    export_json(p, f)
    before = facts(p)
    import_file(p, f)
    after = facts(p)
    assert after["shown"] == before["shown"] and after["pos"] == before["pos"] and after["loaded"] == before["loaded"]
    assert "Its trace" not in after["toast"] and "not on the trace" not in after["toast"], after["toast"]
    c.close()


def test_a_file_with_no_trace_says_how_many_new_vertices_are_loaded_but_not_on_the_trace(browser, mock, errors, tmp_path):
    f = tmp_path / "chain.json"
    exported_chain(browser, mock, errors, f)
    d = json.loads(f.read_text(encoding="utf-8"))
    del d["view"]["trace"]; d["view"]["layout"] = "flow"
    f.write_text(json.dumps(d), encoding="utf-8")
    c, p = sample_page(browser, mock, errors)
    before = facts(p)
    import_file(p, f)
    after = facts(p)
    assert after["shown"] == before["shown"], "no trace in the file, nothing to add to the screen"
    fresh = len([n for n in d["nodes"] if n["type"] in ("tx", "addr")])
    m = re.search(r"(\d+) new vertices are loaded but not on the trace\.", after["toast"])
    assert m and int(m.group(1)) == fresh, "it names how many there are (%d): %s" % (fresh, after["toast"])
    c.close()


def test_the_groups_of_the_file_come_along_with_new_ids(browser, mock, errors, tmp_path):
    f = tmp_path / "grouped.json"
    exported_chain(browser, mock, errors, f, group=True)
    c, p = sample_page(browser, mock, errors)
    mine, _ = make_group(p, NORMAL_ID)
    before = facts(p)
    assert [g["id"] for g in before["groups"]] == [mine]
    import_file(p, f)
    after = facts(p)
    assert len(after["groups"]) == 2, after["groups"]
    ids = {g["id"] for g in after["groups"]}
    assert mine in ids and len(ids) == 2, "the file's group did not take the id of the one already there"
    anchors = {g["anchor"]: g for g in after["groups"]}
    assert "tx:" + tid(10) in anchors and NORMAL_ID in anchors
    assert len(anchors["tx:" + tid(10)]["members"]) >= 2
    assert after["visible"] == len(after["shown"]) + 2, "the two groups are drawn as vertices"
    c.close()
