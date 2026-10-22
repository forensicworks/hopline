"""Pattern flags on the canvas (PEEL 3/5, CONSOL 6>1 ...): text where it fits, a dot where it does not, one colour per peel chain, and a switch per kind."""
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


def zoom(page, k):
    page.evaluate("(k) => { const r = window.__hopline.renderer; r.zoomBy(k / r.view.k); }", k)
    page.wait_for_timeout(120)


def drawn(page):
    """The pattern flags as drawn: their text (the small bold 9.5 px writing) and the little dots that stand in for text."""
    return page.evaluate("""() => { const r = window.__hopline.renderer, ctx = r.ctx, ft = ctx.fillText.bind(ctx), ar = ctx.arc.bind(ctx), texts = [], dots = [];
        ctx.fillText = (t, x, y, ...a) => { if (/^bold 9[.]5px/.test(ctx.font)) texts.push({ t: String(t), x, y, w: ctx.measureText(String(t)).width }); return ft(t, x, y, ...a); };
        ctx.arc = (x, y, rad, ...a) => { if (rad === 3.2) dots.push({ x, y }); return ar(x, y, rad, ...a); };
        r.draw(); ctx.fillText = ft; ctx.arc = ar; return { texts, dots }; }""")


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


def test_zoomed_out_the_flags_are_dots_and_zoomed_in_they_are_text(fpage, mock):
    scene(fpage, mock)
    fpage.evaluate("() => window.__hopline.setSel([])")                                      # the selected vertex keeps its text; nothing else does
    zoom(fpage, 0.12)
    far = drawn(fpage)
    assert flag_texts(far) == [] and len(far["dots"]) >= 8, "no text to pile up, but every flagged transaction is marked"
    zoom(fpage, 0.6)
    near = drawn(fpage)
    assert any(x["t"].startswith("PEEL") for x in flag_texts(near)) and any(x["t"].startswith("CONSOL") for x in flag_texts(near))


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
    fpage.evaluate("() => { document.getElementById('anFlags').closest('details').open = true; }")
    fpage.uncheck("#anFlags"); fpage.wait_for_timeout(150)
    d = drawn(fpage)
    assert flag_texts(d) == [] and d["dots"] == []
    assert CHAIN_LABEL in fpage.inner_text("#anFindings") and "PEEL" in fpage.inner_text("#anFindings"), "the lists in the panel are not affected"
