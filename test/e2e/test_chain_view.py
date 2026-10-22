"""A peel chain on the canvas: its path lit in the chain's colour, its steps numbered, the rest faded; Trace this chain; stepping along it; following it further."""
import pytest

from chains import peel_chain, tid
from helpers import idle, open_query, settle
from test_detections import delete, open_list
from test_pattern_flags import CHAIN_LABEL, scene
from test_trace import shown

STEPS = ["tx:" + tid(n) for n in range(10, 16)]


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def drawn(page):
    """What the chain adds to a frame: the numbers on the steps, the glow under the path, the vertices drawn faded."""
    return page.evaluate("""() => { const r = window.__hopline.renderer, ctx = r.ctx, ft = ctx.fillText.bind(ctx), st = ctx.stroke.bind(ctx), fl = ctx.fill.bind(ctx), out = { nums: [], glow: 0, faded: 0 };
        ctx.fillText = (t, x, y, ...a) => { if (/^bold 10px/.test(ctx.font) && /^[0-9]+$/.test(String(t))) out.nums.push(String(t)); return ft(t, x, y, ...a); };
        ctx.stroke = (...a) => { if (Math.abs(ctx.globalAlpha - 0.28) < 0.001) out.glow++; return st(...a); };
        ctx.fill = (...a) => { if (Math.abs(ctx.globalAlpha - 0.15) < 0.001) out.faded++; return fl(...a); };
        r.draw(); ctx.fillText = ft; ctx.stroke = st; ctx.fill = fl; return out; }""")


def lit(page):
    return page.evaluate("() => { const c = window.__hopline.renderer.chain; return c ? c.label : null; }")


def clear_selection(page):
    page.evaluate("() => window.__hopline.setSel([])"); settle(page)


def inspector_buttons(page):
    return page.evaluate("() => [...document.querySelectorAll('#inspBody .insp-actions button')].map((b) => b.textContent.trim())")


def chip(page):
    return {"visible": page.is_visible("#chainChip"), "text": page.inner_text("#chainChip") if page.is_visible("#chainChip") else ""}


def test_show_on_graph_lights_the_path_numbers_the_steps_and_fades_the_rest(fpage, mock):
    scene(fpage, mock)
    clear_selection(fpage)
    d = drawn(fpage)
    assert d["nums"] == [] and d["glow"] == 0 and d["faded"] == 0, "nothing is lit until you ask"
    open_list(fpage)
    assert not fpage.is_visible("#detChainActs"), "the chain buttons appear once a chain is picked"
    fpage.select_option("#detChain", CHAIN_LABEL)
    assert fpage.is_visible("#detChainActs") and fpage.inner_text("#detShowChain") == "Show on graph"
    fpage.click("#detShowChain"); settle(fpage)
    assert lit(fpage) == CHAIN_LABEL
    c = chip(fpage)
    assert c["visible"] and CHAIN_LABEL in c["text"] and "6 transactions" in c["text"]
    assert fpage.inner_text("#detShowChain") == "Clear the highlight"
    d = drawn(fpage)
    assert sorted(d["nums"]) == ["1", "2", "3", "4", "5", "6"], d
    assert d["glow"] == 12, "the way in, six large outputs and five links between steps are glowing"
    assert d["faded"] > 0, "the CONSOL and COINJOIN? transactions and their wallets fade"
    inside = fpage.evaluate("""(ids) => { const r = window.__hopline.renderer; return ids.every((id) => { const p = r.positionOf(id), x = p.x * r.view.k + r.view.x, y = p.y * r.view.k + r.view.y;
        return x > 0 && x < r.w && y > 0 && y < r.h; }); }""", STEPS)
    assert inside, "the view was moved to take in the whole chain"
    fpage.click("#chainChipClear"); settle(fpage)
    assert lit(fpage) is None and not chip(fpage)["visible"]
    d = drawn(fpage)
    assert d["nums"] == [] and d["glow"] == 0 and d["faded"] == 0
    assert fpage.inner_text("#detShowChain") == "Show on graph"


def test_the_button_toggles_and_a_chain_that_no_longer_exists_clears_itself(fpage, mock):
    scene(fpage, mock)
    clear_selection(fpage)
    open_list(fpage); fpage.select_option("#detChain", CHAIN_LABEL)
    fpage.click("#detShowChain"); settle(fpage)
    assert lit(fpage) == CHAIN_LABEL
    fpage.click("#detShowChain"); settle(fpage)
    assert lit(fpage) is None, "the same button puts it out again"
    fpage.click("#detShowChain"); settle(fpage)
    delete(fpage, "tx:" + tid(12))                                                          # two and three steps are not a chain any more
    assert lit(fpage) is None and not chip(fpage)["visible"]
    assert fpage.evaluate("() => window.__hopline.state.chainFocus") is None


def test_the_details_of_a_step_walk_along_the_chain_and_light_it(fpage, mock):
    scene(fpage, mock)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", STEPS[2]); settle(fpage)
    b = inspector_buttons(fpage)
    for want in ("◀ Step 2", "Step 4 ▶", "Show the chain", "Trace this chain", "Follow ▶▶"):
        assert want in b, (want, b)
    fpage.evaluate("(id) => window.__hopline.setSel([id])", STEPS[0]); settle(fpage)
    b = inspector_buttons(fpage)
    assert not any(x.startswith("◀ Step") for x in b) and "Step 2 ▶" in b, "the first step has nothing before it"
    fpage.evaluate("(id) => window.__hopline.setSel([id])", STEPS[5]); settle(fpage)
    b = inspector_buttons(fpage)
    assert "◀ Step 5" in b and not any(x.endswith("▶") and x.startswith("Step") for x in b), "the last step has nothing after it"
    fpage.evaluate("(id) => window.__hopline.setSel([id])", STEPS[2]); settle(fpage)
    fpage.click("#inspBody .insp-actions button:has-text('Step 4 ▶')"); settle(fpage)
    assert fpage.evaluate("() => [...window.__hopline.state.selected]") == [STEPS[3]]
    fpage.click("#inspBody .insp-actions button:has-text('◀ Step 3')"); settle(fpage)
    assert fpage.evaluate("() => [...window.__hopline.state.selected]") == [STEPS[2]]
    fpage.click("#inspBody .insp-actions button:has-text('Show the chain')"); settle(fpage)
    assert lit(fpage) == CHAIN_LABEL and "Clear the highlight" in inspector_buttons(fpage)
    fpage.click("#inspBody .insp-actions button:has-text('Clear the highlight')"); settle(fpage)
    assert lit(fpage) is None and "Show the chain" in inspector_buttons(fpage)


def test_trace_this_chain_starts_a_trace_with_its_steps_in_order_and_undo_takes_the_reveal_back(fpage, mock):
    scene(fpage, mock)
    open_list(fpage); fpage.select_option("#detChain", CHAIN_LABEL)
    asked = len(mock.requests)
    fpage.click("#detTraceChain"); idle(fpage); settle(fpage)
    assert mock.requests[asked:] == [], "everything it shows was loaded already: nothing is asked of the data source"
    assert fpage.evaluate("() => window.__hopline.state.layout") == "trace"
    s = shown(fpage)
    assert set(STEPS) <= s, "every step is shown"
    assert "tx:" + tid(30) not in s and "tx:" + tid(50) not in s, "and not the other patterns that were on the canvas"
    assert fpage.evaluate("() => window.__hopline.state.trace.seed") == STEPS[0]
    xs = fpage.evaluate("(ids) => ids.map((id) => window.__hopline.renderer.positionOf(id).x)", STEPS)
    assert all(a < b for a, b in zip(xs, xs[1:])), "the steps run left to right in order: %s" % xs
    assert lit(fpage) == CHAIN_LABEL and chip(fpage)["visible"]
    d = drawn(fpage)
    assert sorted(d["nums"]) == ["1", "2", "3", "4", "5", "6"] and d["glow"] == 11, "the way in to the first step is not shown (its ◀ handle brings it)"
    assert len([x for x in s if x.startswith("addr:")]) == 12, "each step's two outputs: the payment and where the rest went"
    fpage.locator("#cv").focus(); fpage.keyboard.press("Control+z"); settle(fpage)
    assert STEPS[0] in shown(fpage) and STEPS[3] not in shown(fpage), "Ctrl+Z takes the reveal back"


def test_trace_this_chain_replaces_the_trace_and_undo_brings_it_back(tpage, mock):
    peel_chain(mock, 6)
    open_query(tpage, tid(10))
    tpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: 6, follow: 'largest' })", STEPS[0]); idle(tpage); settle(tpage)
    before = shown(tpage)
    victim = STEPS[3]
    tpage.evaluate("(id) => window.__hopline.setSel([id])", victim); settle(tpage)
    tpage.click("#traceHide"); settle(tpage)
    assert victim not in shown(tpage)
    open_list(tpage); tpage.select_option("#detChain", CHAIN_LABEL)
    tpage.click("#detShowChain"); settle(tpage)
    assert "Only 5 of the 6 steps are on screen" in tpage.inner_text("#toast") and "Trace this chain shows them all" in tpage.inner_text("#toast")
    tpage.click("#detTraceChain"); idle(tpage); settle(tpage)
    assert before <= shown(tpage) or set(STEPS) <= shown(tpage)
    assert victim in shown(tpage), "the step that was hidden is back"
    xs = tpage.evaluate("(ids) => ids.map((id) => window.__hopline.renderer.positionOf(id).x)", STEPS)
    assert all(a < b for a, b in zip(xs, xs[1:]))
    tpage.locator("#cv").focus(); tpage.keyboard.press("Control+z"); settle(tpage)         # the reveal
    tpage.keyboard.press("Control+z"); settle(tpage)                                         # the restart
    assert victim not in shown(tpage) and STEPS[1] in shown(tpage), "back to the trace as it was before, with the step still hidden"


def test_follow_carries_the_chain_on_and_it_keeps_its_name(fpage, mock):
    peel_chain(mock, 8)
    open_query(fpage, tid(10))
    fpage.evaluate("(id) => window.__hopline.autoExpand(id, { dir: 'next', hops: 4, follow: 'largest' })", STEPS[0]); idle(fpage); settle(fpage)
    fpage.uncheck("#focusOn"); settle(fpage)
    chain = lambda: fpage.evaluate("() => window.__hopline.analysis().chains.map((c) => [c.label, c.ids.length])")
    assert chain() == [[CHAIN_LABEL, 5]]
    fpage.evaluate("() => { window.__hopline.state.auto.hops = 6; }")
    fpage.evaluate("(id) => window.__hopline.setSel([id])", "tx:" + tid(14)); settle(fpage)
    fpage.click("#inspBody .insp-actions button:has-text('Follow ▶▶')"); idle(fpage); settle(fpage)
    assert chain() == [[CHAIN_LABEL, 8]], "three more steps were loaded and the chain is still called the same"
