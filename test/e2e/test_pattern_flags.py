"""Pattern flags on the canvas (PEEL 3/5, CONSOL 6>1 ...): a ring round the transaction for each (at any zoom), the name as text where it fits, one colour per peel chain, and a switch per kind."""
import json

import pytest

from chains import coinjoin, consolidation, peel_chain, tid
from helpers import idle, open_query, settle

CHAIN_FIRST = tid(10)
CHAIN_LABEL = "P-" + CHAIN_FIRST[:4]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def scene(fpage, mock, n=6):
    """A peel chain of n steps, a consolidation and a CoinJoin-like transaction, all on screen."""
    peel_chain(mock, n); consolidation(mock); coinjoin(mock)
    open_query(fpage, tid(10))
    fpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: 6, follow: 'largest' })", "tx:" + tid(10)); idle(fpage); settle(fpage)
    open_query(fpage, tid(30)); open_query(fpage, tid(50))
    fpage.uncheck("#focusOn"); settle(fpage)


def fold_panel(page):
    """The findings panel opens by itself when something is found and takes room from the canvas; these tests measure zoom on the whole canvas."""
    if page.is_visible("#inspCollapse"):
        page.click("#inspCollapse")
    settle(page)


def zoom(page, k):
    page.evaluate("(k) => { const r = window.__hopline.renderer; r.zoomBy(k / r.view.k); }", k)
    page.wait_for_timeout(120)


def drawn(page):
    """The pattern flags as drawn: their text (the small bold 9.5 px writing) and the rings round the transactions."""
    return page.evaluate("""() => { const r = window.__hopline.renderer, ctx = r.ctx, ft = ctx.fillText.bind(ctx), texts = [];
        ctx.fillText = (t, x, y, ...a) => { if (/^bold 9[.]5px/.test(ctx.font)) texts.push({ t: String(t), x, y, w: ctx.measureText(String(t)).width }); return ft(t, x, y, ...a); };
        r.draw(); ctx.fillText = ft; return { texts, rings: r.findingRings.map((q) => Object.assign({}, q)) }; }""")


def flag_texts(d):
    return [x for x in d["texts"] if x["t"].startswith(("PEEL", "CONSOL", "BATCH", "COINJOIN"))]


def overlaps(items):
    out = []
    for i, a in enumerate(items):
        for b in items[i + 1:]:
            if a["x"] - a["w"] / 2 < b["x"] + b["w"] / 2 and b["x"] - b["w"] / 2 < a["x"] + a["w"] / 2 and a["y"] - 10 < b["y"] + 3 and b["y"] - 10 < a["y"] + 3:
                out.append((a["t"], b["t"]))
    return out


def test_a_peel_chain_is_named_after_where_it_starts_and_its_steps_share_one_colour(fpage, mock):
    scene(fpage, mock)
    an = fpage.evaluate("""() => { const a = window.__hopline.analysis(); return { chains: a.chains.map((c) => ({ label: c.label, color: c.color, n: c.ids.length })),
        colours: [...a.tx.values()].filter((r) => r.chain).map((r) => r.flags.find((f) => f.kind === 'peel').color) }; }""")
    assert [c["label"] for c in an["chains"]] == [CHAIN_LABEL] and an["chains"][0]["n"] == 6
    assert set(an["colours"]) == {an["chains"][0]["color"]} and len(an["colours"]) == 6
    assert CHAIN_LABEL in fpage.inner_text("#anFindings"), "the Analysis panel uses the same name"


def test_zoomed_out_the_flags_are_rings_only_and_zoomed_in_they_are_rings_and_text(fpage, mock):
    scene(fpage, mock)
    fold_panel(fpage)
    fpage.evaluate("() => window.__hopline.setSel([])")                                      # the selected vertex keeps its text; nothing else does
    zoom(fpage, 0.12)
    far = drawn(fpage)
    assert flag_texts(far) == [] and len(far["rings"]) >= 8, "no text to pile up, but every flagged transaction is marked"
    zoom(fpage, 0.6)
    near = drawn(fpage)
    assert any(x["t"].startswith("PEEL") for x in flag_texts(near)) and any(x["t"].startswith("CONSOL") for x in flag_texts(near))
    assert len(near["rings"]) >= 8, "the rings are still there"


def test_flag_text_never_sits_on_top_of_other_flag_text_at_any_zoom(fpage, mock):
    scene(fpage, mock)
    for k in (0.12, 0.2, 0.3, 0.4, 0.6, 1.0, 1.6):
        zoom(fpage, k)
        d = drawn(fpage)
        assert overlaps(flag_texts(d)) == [], "zoom %s: %s" % (k, overlaps(flag_texts(d)))


def test_the_vertex_you_point_at_or_select_names_its_peel_chain_even_when_zoomed_out(fpage, mock):
    scene(fpage, mock)
    zoom(fpage, 0.12)
    step = "tx:" + tid(12)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", step); fpage.wait_for_timeout(150)
    d = drawn(fpage)
    assert any(x["t"] == "PEEL 3/6 · " + CHAIN_LABEL for x in d["texts"]), [x["t"] for x in d["texts"]]
    fpage.evaluate("() => window.__hopline.setSel([])"); fpage.wait_for_timeout(100)
    assert not any(CHAIN_LABEL in x["t"] for x in drawn(fpage)["texts"]), "only the one you chose"


def test_each_kind_can_be_switched_off_and_the_choice_is_remembered(fpage, mock):
    scene(fpage, mock)
    fold_panel(fpage)
    fpage.evaluate("() => window.__hopline.setSel([])")
    zoom(fpage, 0.6)
    assert any(x["t"].startswith("PEEL") for x in flag_texts(drawn(fpage)))
    fpage.evaluate("() => { document.getElementById('anFlags').closest('details').open = true; }")
    fpage.uncheck("#anKPeel"); fpage.wait_for_timeout(150)
    kinds = {x["t"].split(" ")[0] for x in flag_texts(drawn(fpage))}
    assert "PEEL" not in kinds and "CONSOL" in kinds, kinds
    assert json.loads(fpage.evaluate("() => localStorage.getItem('hopline.prefs.v1')"))["analysis"]["kinds"]["peel"] is False
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    assert fpage.evaluate("() => window.__hopline.state.analysis.kinds.peel") is False
    fpage.evaluate("() => { document.getElementById('anFlags').closest('details').open = true; }")
    assert not fpage.is_checked("#anKPeel") and fpage.is_checked("#anKConsol")
    assert fpage.evaluate("() => window.__hopline.state.analysis.kinds.consolidation") is True


def test_switching_the_flags_off_altogether_still_lists_what_was_found(fpage, mock):
    scene(fpage, mock)
    fold_panel(fpage)
    fpage.evaluate("() => { document.getElementById('anFlags').closest('details').open = true; }")
    fpage.uncheck("#anFlags"); fpage.wait_for_timeout(150)
    d = drawn(fpage)
    assert flag_texts(d) == [] and d["rings"] == []
    assert CHAIN_LABEL in fpage.inner_text("#anFindings") and "PEEL" in fpage.inner_text("#anFindings"), "the lists in the panel are not affected"


# ---- a ring for each finding: what the canvas does with the findings a transaction carries (handed to it by hand, so the shapes of the analysis do not matter here) ----
SWAP = {"text": "SWAP \u2192 ETH", "color": "#d98a3d", "kind": "swap", "chain": ""}
CONSOL = {"text": "CONSOL 6\u21921", "color": "#b58cff", "kind": "consolidation", "chain": ""}
PEEL = {"text": "PEEL 3/6", "color": "#ffb347", "kind": "peel", "chain": "P-0a1b"}
COIN = {"text": "COINJOIN?", "color": "#ff7aa2", "kind": "coinjoin", "chain": ""}


def force(page, id_, flags, start=False):
    """Hand the canvas these findings for one transaction (and START if asked) in place of the analysis, and draw it again."""
    page.evaluate("""([id, flags, start]) => { const r = window.__hopline.renderer, d = r.data;
        d.nodeFlags = (n) => n.id === id ? flags : null; d.seedIds = start ? new Set([id]) : new Set();
        const p = r.positionOf(id); r.view.x = r.w / 2 - p.x * r.view.k; r.view.y = r.h / 2 - p.y * r.view.k; r.draw(); }""", [id_, flags, start])


def pixel(page, x, y):
    """The canvas colour at a point given in canvas coordinates (CSS pixels)."""
    return page.evaluate("""([x, y]) => { const c = window.__hopline.renderer.canvas, k = c.width / c.clientWidth;
        return Array.from(c.getContext('2d').getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data).slice(0, 3); }""", [x, y])


def near_colour(rgb, hexcolour, tol=60):
    want = [int(hexcolour[i:i + 2], 16) for i in (1, 3, 5)]
    return all(abs(a - b) <= tol for a, b in zip(rgb, want))


def test_a_flagged_start_transaction_shows_the_finding_by_name_and_by_ring(fpage, mock):
    """The case that used to leave only a dot: START takes the row nearest the vertex, so the name of the finding went."""
    scene(fpage, mock); fold_panel(fpage)
    fpage.evaluate("() => window.__hopline.setSel([])"); zoom(fpage, 1.0)
    force(fpage, "tx:" + tid(30), [COIN], start=True)
    d = drawn(fpage)
    texts = [x for x in d["texts"] if x["t"] in ("START", "COINJOIN?")]
    assert sorted(x["t"] for x in texts) == ["COINJOIN?", "START"] and overlaps(texts) == [], texts
    assert [(q["kind"], q["id"]) for q in d["rings"]] == [("coinjoin", "tx:" + tid(30))]


def test_each_finding_is_a_ring_the_first_innermost_and_the_swap_is_one_too(fpage, mock):
    scene(fpage, mock); fold_panel(fpage)
    fpage.evaluate("() => window.__hopline.setSel([])"); zoom(fpage, 1.0)
    force(fpage, "tx:" + tid(30), [SWAP, CONSOL, PEEL])
    rings = drawn(fpage)["rings"]
    assert [q["kind"] for q in rings] == ["swap", "consolidation", "peel"], "a ring for each, in the order of the findings"
    assert [q["off"] for q in rings] == [2.5, 5.5, 8.5], "3 px apart whatever the shape"
    assert [q["color"] for q in rings] == [SWAP["color"], CONSOL["color"], PEEL["color"]]


def test_the_names_stack_without_gaps_and_without_overlap_at_every_zoom_and_a_selected_vertex_shows_them_all(fpage, mock):
    scene(fpage, mock); fold_panel(fpage)
    fpage.evaluate("() => window.__hopline.setSel([])")
    for k in (0.3, 0.6, 1.0, 1.6):
        zoom(fpage, k)
        force(fpage, "tx:" + tid(30), [SWAP, CONSOL, PEEL], start=True)
        names = [x for x in drawn(fpage)["texts"] if x["t"] in ("START", SWAP["text"], CONSOL["text"], PEEL["text"])]
        assert overlaps(names) == [], "zoom %s: %s" % (k, overlaps(names))
        assert "START" in [x["t"] for x in names] and SWAP["text"] in [x["t"] for x in names], "START and the first finding"
        assert len(names) == 3, "three rows in all while nothing is pointed at: %s" % [x["t"] for x in names]
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "tx:" + tid(30)); fpage.wait_for_timeout(150)
    force(fpage, "tx:" + tid(30), [SWAP, CONSOL, PEEL], start=True)
    names = [x["t"] for x in drawn(fpage)["texts"] if x["t"].startswith(("START", "SWAP", "CONSOL", "PEEL"))]
    assert len(names) == 4, "selected: every name and START: %s" % names


def test_a_selected_transaction_keeps_its_rings_inside_the_selection_ring(fpage, mock):
    scene(fpage, mock); fold_panel(fpage)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "tx:" + tid(30)); zoom(fpage, 1.0)
    force(fpage, "tx:" + tid(30), [CONSOL, PEEL])
    rings = drawn(fpage)["rings"]
    assert len(rings) == 2
    for q in rings:                                                     # the right-hand side of a square is straight: the ring is where the edge is plus its offset
        got = pixel(fpage, q["edge"] + q["off"], q["y"])
        assert near_colour(got, q["color"]), "the %s ring is not covered: %s" % (q["kind"], got)
    sel = pixel(fpage, rings[0]["edge"] + 6 + 3.5 * rings[0]["side"], rings[0]["y"])
    assert min(sel) > 200, "the selection ring sits outside the finding rings: %s" % sel
