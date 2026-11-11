"""One colour pair for the whole site: what comes in is green and what goes out is pink on the wallet page (rows, the bars under the chart, the tip) and in the workspace (the side panel; the arrows
are in test_arrow_direction.py), and both pages read the pair from the style module, so the two cannot drift apart."""
import pytest

from helpers import settle
from test_wallet_chart_more import buckets, mixed, over_bar
from test_wallet_chart_range import goto, wpage  # noqa: F401  (the fixture is used by name)
from test_wallet_history import utc

ARRIVES, LEAVES = "rgb(107, 230, 117)", "rgb(240, 107, 208)"                   # #6be675 and #f06bd0


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def probe(page):
    """What the style sheet gives to the in and out marks of the side panel (elements of the same classes, put in the page for a moment) and what the page's own variables are."""
    return page.evaluate("""() => {
        const box = document.createElement('div');
        box.innerHTML = '<span class="dirtag in">a</span><span class="dirtag out">b</span><div class="linkrow in"><span class="amt">1</span></div><div class="linkrow out"><span class="amt">2</span></div>';
        document.body.appendChild(box);
        const c = (s) => getComputedStyle(box.querySelector(s)).color, bg = (s) => getComputedStyle(box.querySelector(s)).backgroundColor;
        const r = { tagIn: c('.dirtag.in'), tagOut: c('.dirtag.out'), amtIn: c('.linkrow.in .amt'), amtOut: c('.linkrow.out .amt'), bgIn: bg('.dirtag.in'), bgOut: bg('.dirtag.out') };
        box.remove();
        const css = getComputedStyle(document.documentElement);
        r.arrive = css.getPropertyValue('--arrive').trim(); r.leave = css.getPropertyValue('--leave').trim();
        r.module = HoplineStyle.directionColors();
        return r; }""")


def test_the_wallet_page_rows_show_what_came_in_in_green_and_what_went_out_in_pink(wpage, mock):
    mixed(mock)
    goto(wpage)
    colours = wpage.evaluate("""() => { const c = (s) => getComputedStyle(document.querySelector(s)); return { netIn: c('.net.in').color, netOut: c('.net.out').color, bgIn: c('.net.in').backgroundColor, bgOut: c('.net.out').backgroundColor,
                                                                                         borderOut: c('.tx.out').borderLeftColor, borderIn: c('.tx.in').borderLeftColor,
                                                                                         chipIn: c('.amt.in').backgroundColor, chipOut: c('.amt.out').backgroundColor, inkIn: c('.amt.in').color, count: document.querySelectorAll('.net.in, .net.out').length }; }""")
    assert colours["count"] >= 3, colours
    assert colours["netIn"] == ARRIVES and colours["netOut"] == LEAVES and colours["borderOut"] == LEAVES and colours["borderIn"] == ARRIVES, colours
    assert colours["bgIn"] == "rgba(107, 230, 117, 0.14)" and colours["bgOut"] == "rgba(240, 107, 208, 0.14)", colours
    assert colours["chipIn"] == LEAVES and colours["chipOut"] == ARRIVES, "an input is a coin that is spent (pink), an output a coin that is created (green): %s" % colours
    assert colours["inkIn"] == "rgb(14, 15, 14)", "dark text on the lighter chips: %s" % colours


def test_the_bars_under_the_chart_and_the_tip_use_the_same_two_colours(wpage, mock):
    mixed(mock)
    goto(wpage)
    seen = wpage.evaluate("""() => { const c = document.getElementById('chart'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, n = { up: 0, down: 0, old: 0 };
        const near = (r, g, b, c) => Math.abs(r - c[0]) <= 4 && Math.abs(g - c[1]) <= 4 && Math.abs(b - c[2]) <= 4;
        for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 200) continue; const r = d[i], g = d[i + 1], b = d[i + 2];     // the bars are drawn at 85 % opacity on a canvas without a background of its own: the colour itself, give or take a rounding
          if (near(r, g, b, [107, 230, 117])) n.up++; else if (near(r, g, b, [240, 107, 208])) n.down++; else if (near(r, g, b, [255, 159, 67])) n.old++; }
        return n; }""")
    assert seen["up"] > 40 and seen["down"] > 40 and seen["old"] == 0, "pixels of the bars in green, in pink and in the old orange: %s" % seen
    froms = [k["from"] for k in buckets(wpage)]
    over_bar(wpage, froms.index(utc(2022, 3, 2, 0)))
    wpage.wait_for_selector("#chartTip:not([hidden])")
    assert wpage.eval_on_selector("#chartTip .down", "e => getComputedStyle(e).color") == LEAVES
    over_bar(wpage, froms.index(utc(2022, 3, 1, 0)))
    assert wpage.eval_on_selector("#chartTip .up", "e => getComputedStyle(e).color") == ARRIVES
    wpage.mouse.move(5, 5)


def test_the_wallet_page_takes_its_two_colours_from_the_style_module(wpage, mock):
    mixed(mock)
    goto(wpage)
    r = probe(wpage)
    assert r["arrive"] == "#6be675" == r["module"]["arrives"] and r["leave"] == "#f06bd0" == r["module"]["leaves"], r


def test_the_workspace_side_panel_uses_them_too_and_the_page_variables_are_the_module(fpage):
    settle(fpage)
    r = probe(fpage)
    assert (r["tagIn"], r["amtIn"]) == (ARRIVES, ARRIVES) and (r["tagOut"], r["amtOut"]) == (LEAVES, LEAVES), r
    assert r["bgIn"] == "rgba(107, 230, 117, 0.14)" and r["bgOut"] == "rgba(240, 107, 208, 0.14)", r
    assert r["arrive"] == "#6be675" == r["module"]["arrives"] and r["leave"] == "#f06bd0" == r["module"]["leaves"], r
