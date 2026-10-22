"""The project used to be called Orion: what an older version saved in the browser, and files it wrote, still work."""
import json

import pytest

from conftest import PAGE_URL, ROOT
from test_wallet_page import ADDRESS, PAYER, WALLET_URL

OLD_SESSION = json.dumps({"format": "orion-workspace", "version": 1, "exported": "2026-01-02T03:04:05Z",
                          "nodes": [{"id": "addr:evil", "type": "addr", "address": "evil", "label": "from the old days"},
                                    {"id": "tx:" + "a" * 64, "type": "tx", "txid": "a" * 64, "loaded": False}],
                          "edges": [{"id": "in:" + "a" * 64 + ":0", "source": "addr:evil", "target": "tx:" + "a" * 64, "kind": "in", "amount": 5, "txid": "a" * 64}]})
OLD_PREFS = json.dumps({"hops": 3, "stepSize": 7, "source": "blockstream", "fallback": False})
OLD_PACKS = json.dumps([{"id": "p1", "name": "Old case list", "enabled": True, "entries": [[PAYER, "Old suspect", "THREAT", "", ""]]}])


def seed(ctx, **keys):
    """Put things in localStorage once (a sentinel stops the script from putting them back after a reload)."""
    lines = ["if (!localStorage.getItem('__seeded')) { localStorage.setItem('__seeded', '1');"]
    lines += ["localStorage.setItem(%s, %s);" % (json.dumps(k), json.dumps(v)) for k, v in keys.items()]
    lines.append("}")
    ctx.add_init_script("\n".join(lines))


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def test_what_an_older_version_saved_moves_to_the_new_names_and_is_used(ctx, errors):
    seed(ctx, **{"orion.workspace.v1": OLD_SESSION, "orion.prefs.v1": OLD_PREFS, "orion.packs.v1": OLD_PACKS, "orion.ext.token": "old-token"})
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(PAGE_URL); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    keys = p.evaluate("() => Object.keys(localStorage).filter((k) => /^(orion|hopline)[.]/.test(k)).sort()")
    assert keys == ["hopline.ext.token", "hopline.packs.v1", "hopline.prefs.v1", "hopline.workspace.v1"], "moved, not copied: nothing is left under the old names"
    assert p.is_visible("#restore") and "2 vertices" in p.inner_text("#restoreText"), "the old session, still in the old file format, is offered"
    st = p.evaluate("() => ({ hops: window.__hopline.state.hops, step: window.__hopline.state.stepSize, source: window.__hopline.state.source, packs: window.__hopline.state.packs.map((x) => x.name) })")
    assert st == {"hops": 3, "step": 7, "source": "blockstream", "packs": ["Old case list"]}
    p.click("#restoreYes"); p.wait_for_function("() => window.__hopline.state.graph.nodes.size === 2")
    assert p.evaluate("() => window.__hopline.state.graph.nodes.get('addr:evil').label") == "from the old days"


def test_a_new_session_wins_over_a_leftover_old_one_and_the_old_one_is_removed(ctx, errors):
    new = OLD_SESSION.replace("orion-workspace", "hopline-workspace").replace("from the old days", "newer")
    seed(ctx, **{"orion.workspace.v1": OLD_SESSION, "hopline.workspace.v1": new})
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(PAGE_URL); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert p.evaluate("() => localStorage.getItem('orion.workspace.v1')") is None
    p.click("#restoreYes"); p.wait_for_function("() => window.__hopline.state.graph.nodes.size === 2")
    assert p.evaluate("() => window.__hopline.state.graph.nodes.get('addr:evil').label") == "newer"


def test_discarding_the_saved_session_does_not_bring_the_old_copy_back(ctx, errors):
    seed(ctx, **{"orion.workspace.v1": OLD_SESSION})
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(PAGE_URL); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    p.click("#restoreNo")
    p.reload(); p.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert p.is_hidden("#restore") and p.evaluate("() => localStorage.getItem('hopline.workspace.v1')") is None


def test_the_wallet_page_reads_the_old_names_too(ctx, errors):
    seed(ctx, **{"orion.packs.v1": OLD_PACKS, "orion.prefs.v1": json.dumps({"source": "blockstream", "fallback": False})})
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(WALLET_URL + "?q=" + ADDRESS)
    p.wait_for_function("() => document.querySelectorAll('#ledger .tx').length > 0")
    assert p.locator("#assoc .assocrow").filter(has_text="Old suspect").count() == 1, "label list saved under the old name"
    assert "blockstream.info" in p.inner_text("#source") and "backup" not in p.inner_text("#source"), "server choice saved under the old name"
