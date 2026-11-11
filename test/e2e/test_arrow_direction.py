"""Colour arrows by direction: an input arrow (a coin spent, wallet into transaction) and an output arrow (a coin created, transaction to wallet) get a colour of their own, checked on the pixels of the
canvas. The amber arrow of a possible change, a hovered arrow and the vertices keep theirs; the setting is saved with the workspace and goes along in a share link."""
import json

import pytest

from conftest import PAGE_URL
from helpers import open_query, settle
from chains import tid
from test_edge_lanes import SHOP, TX, WALLET, change, lane_points
from test_export_provenance_json import workspace_json
from test_share_ids_link import make_ids_link, open_link as open_ids, payload_of
from test_share_link import capture, make_link, open_link, scene


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def block(page, pt, r=3):
    """The colours of the canvas pixels in a small square round a page point (a thin arrow is drawn across two rows of pixels, and a dashed one has gaps)."""
    return page.evaluate("""([pt, r]) => { const c = window.__hopline.renderer.canvas, b = c.getBoundingClientRect(), k = c.width / c.clientWidth, g = c.getContext('2d');
        const x = Math.floor((pt.x - b.left) * k) - r, y = Math.floor((pt.y - b.top) * k) - r, d = g.getImageData(x, y, 2 * r + 1, 2 * r + 1).data, out = [];
        for (let i = 0; i < d.length; i += 4) out.push([d[i], d[i + 1], d[i + 2]]); return out; }""", [pt, r])


def rgb(page, pt):
    return block(page, pt, 0)[0]


def shop_point(page, f=0.3):
    """A point on the arrow from the transaction to the shop, which has no partner going the other way."""
    return page.evaluate("""([t, s, f]) => { const r = window.__hopline.renderer, a = r._toScreen(r.cur.get(t)), b = r._toScreen(r.cur.get(s)), box = r.canvas.getBoundingClientRect();
        return { x: box.left + a.x + (b.x - a.x) * f, y: box.top + a.y + (b.y - a.y) * f }; }""", [TX, SHOP, f])


FRACTIONS = (0.15, 0.22, 0.3, 0.38, 0.46, 0.54, 0.62, 0.7, 0.78, 0.85)
BEYOND = (0.64, 0.7, 0.76, 0.82, 0.88)                                      # the arrow to the shop runs close to the lanes near the transaction and behind the wallet: only its far part is clear of them


def spread(c):
    return max(c) - min(c)


def points(page):
    p = lane_points(page)
    assert p["len"] > 120, "far enough apart to sample the lanes"
    return {"into": [lane_points(page, f)["into"] for f in FRACTIONS], "back": [lane_points(page, f)["back"] for f in FRACTIONS], "shop": [shop_point(page, f) for f in BEYOND]}


def colour(page, pts):
    """The colour of an arrow: the most saturated pixel along it (a thin or dashed arrow has gaps, and a label sits on it)."""
    return max((c for pt in pts for c in block(page, pt)), key=spread)


def brightest(page, pts):
    return max((c for pt in pts for c in block(page, pt)), key=min)


def opened(fpage, mock):
    change(mock)
    open_query(fpage, tid(80)); settle(fpage)
    return points(fpage)


def turn_on(page, palette=None):
    page.check("#arrowDir")
    if palette:
        page.select_option("#dirPalette", palette)
    settle(page)


def neutral(c):
    return spread(c) < 30                                                  # the renderer's pale cyan-grey: no colour of its own


def amber(c):
    return c[0] > c[2] + 100 and c[1] > c[2] + 50 and c[0] > c[1] + 30      # #ff9f43


# ---- the colours -----------------------------------------------------------------------------------------------------------------------------------

def test_by_default_every_arrow_is_neutral_apart_from_the_amber_change(fpage, mock):
    p = opened(fpage, mock)
    assert neutral(colour(fpage, p["into"])) and neutral(colour(fpage, p["shop"])), (colour(fpage, p["into"]), colour(fpage, p["shop"]))
    assert amber(colour(fpage, p["back"])), "the change the wallet paid back to itself: " + str(colour(fpage, p["back"]))
    assert not fpage.is_checked("#arrowDir") and fpage.is_disabled("#dirPalette")


def test_pink_for_the_coin_that_is_spent_and_green_for_the_one_that_is_created_and_the_change_stays_amber(fpage, mock):
    p = opened(fpage, mock)
    turn_on(fpage)
    into, shop, back = colour(fpage, p["into"]), colour(fpage, p["shop"]), colour(fpage, p["back"])
    assert into[0] > into[1] + 60 and into[2] > into[1] + 50, "input: pink (#f06bd0): %s" % into
    assert shop[1] > shop[0] + 50 and shop[1] > shop[2] + 50, "output: green (#6be675): %s" % shop
    assert not amber(into) and not amber(shop), "neither is mistaken for the amber of the change: %s %s" % (into, shop)
    assert amber(back), "the arrow of the possible change keeps its colour, and is still read as an output by its arrowhead: %s" % back
    assert fpage.is_enabled("#dirPalette")


def test_the_other_pair_is_blue_for_input_and_lime_for_output(fpage, mock):
    p = opened(fpage, mock)
    turn_on(fpage, "bl")
    into, shop = colour(fpage, p["into"]), colour(fpage, p["shop"])
    assert into[2] > into[0] + 70 and into[2] > into[1] + 40, "input: blue (#3b8bff): %s" % into
    assert shop[1] > shop[2] + 60 and shop[0] > shop[2] + 50, "output: lime (#d8f547): %s" % shop
    assert amber(colour(fpage, p["back"])), "and the change is not mistaken for the lime output"


def test_switching_it_off_gives_the_neutral_colours_back(fpage, mock):
    p = opened(fpage, mock)
    turn_on(fpage)
    fpage.uncheck("#arrowDir"); settle(fpage)
    assert neutral(colour(fpage, p["into"])) and neutral(colour(fpage, p["shop"]))
    assert fpage.is_disabled("#dirPalette")


def test_colour_by_age_colours_the_vertices_and_the_arrows_only_while_direction_is_off(fpage, mock):
    p = opened(fpage, mock)
    turn_on(fpage)
    kind_mode = colour(fpage, p["shop"])
    fpage.click("[data-color=age]"); settle(fpage)
    assert all(abs(a - b) <= 4 for a, b in zip(colour(fpage, p["shop"]), kind_mode)), "direction wins over the age colour of an arrow"
    fpage.uncheck("#arrowDir"); settle(fpage)
    aged = colour(fpage, p["shop"])
    assert any(abs(a - b) > 20 for a, b in zip(aged, kind_mode)), "with direction off the age colour is back, and it is not the green: %s against %s" % (aged, kind_mode)


def test_a_hovered_arrow_is_drawn_in_the_selection_colour_whatever_its_direction(fpage, mock):
    p = opened(fpage, mock)
    turn_on(fpage)
    assert colour(fpage, p["shop"])[1] > colour(fpage, p["shop"])[0] + 40
    mid = p["shop"][2]
    fpage.mouse.move(mid["x"], mid["y"]); fpage.wait_for_timeout(300)
    hot = brightest(fpage, p["shop"])
    assert min(hot) > 200, "white (the selection colour) on the arrow under the pointer: %s" % hot
    fpage.mouse.move(5, 5)


# ---- the controls and the legend -------------------------------------------------------------------------------------------------------------------

def test_the_legend_names_the_two_arrows_with_their_colours_and_follows_the_palette(fpage, mock):
    opened(fpage, mock)
    assert "input arrow" not in fpage.inner_text("#legend")
    turn_on(fpage)
    text = fpage.inner_text("#legend")
    assert "input arrow: a coin that is spent" in text and "output arrow: a coin that is created" in text, text
    sw = fpage.eval_on_selector_all("#legend .item .sw", "els => els.map((e) => getComputedStyle(e).backgroundColor)")
    assert "rgb(240, 107, 208)" in sw and "rgb(107, 230, 117)" in sw, sw
    fpage.select_option("#dirPalette", "bl"); settle(fpage)
    sw = fpage.eval_on_selector_all("#legend .item .sw", "els => els.map((e) => getComputedStyle(e).backgroundColor)")
    assert "rgb(59, 139, 255)" in sw and "rgb(216, 245, 71)" in sw and "rgb(240, 107, 208)" not in sw, sw
    assert "amber edge" in fpage.inner_text("#legend"), "the amber entry for the change guess is still there"


def test_the_checkbox_says_what_it_does_and_the_palette_box_says_why_there_are_two(fpage):
    assert "amber" in fpage.get_attribute("label:has(#arrowDir)", "title") and "Colour by Age" in fpage.get_attribute("label:has(#arrowDir)", "title")
    assert "all three kinds of colour blindness" in fpage.get_attribute("#dirPalette", "title") and "wallet page" in fpage.get_attribute("#dirPalette", "title")
    assert [fpage.inner_text("#dirPalette option[value=pg]"), fpage.inner_text("#dirPalette option[value=bl]")] == ["Input pink, output green", "Input blue, output lime"]
    assert fpage.locator("#dirPalette option").count() == 2 and fpage.input_value("#dirPalette") == "pg", "pink and green is the one that is chosen to begin with"


# ---- saved with the workspace, and sent in a link ----------------------------------------------------------------------------------------------------

def test_the_setting_is_in_the_workspace_file_and_comes_back_when_it_is_imported(fpage, ctx, mock, tmp_path):
    opened(fpage, mock)
    turn_on(fpage, "bl")
    d = workspace_json(fpage, tmp_path)
    assert d["view"]["arrowDir"] is True and d["view"]["dirPalette"] == "bl"
    other = ctx.new_page()
    other.goto(PAGE_URL); other.wait_for_function("window.__hopline && window.__hopline.renderer")
    other.set_input_files("#fileImport", files=[{"name": "w.json", "mimeType": "application/json", "buffer": json.dumps(d).encode()}])
    other.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0", timeout=20000); settle(other)
    assert other.is_checked("#arrowDir") and other.input_value("#dirPalette") == "bl" and other.is_enabled("#dirPalette")
    assert other.evaluate("() => window.__hopline.state.arrowDir") is True


def test_a_file_with_nonsense_in_the_setting_is_read_with_the_defaults(fpage, ctx, mock, tmp_path):
    opened(fpage, mock)
    d = workspace_json(fpage, tmp_path)
    d["view"]["arrowDir"] = "yes"; d["view"]["dirPalette"] = "constructor"
    other = ctx.new_page()
    other.goto(PAGE_URL); other.wait_for_function("window.__hopline && window.__hopline.renderer")
    other.set_input_files("#fileImport", files=[{"name": "w.json", "mimeType": "application/json", "buffer": json.dumps(d).encode()}])
    other.wait_for_function("() => window.__hopline.state.graph.nodes.size > 0", timeout=20000); settle(other)
    assert not other.is_checked("#arrowDir") and other.input_value("#dirPalette") == "pg"


def test_a_link_to_the_canvas_and_a_link_of_ids_carry_it(page, ctx, mock):
    scene(page, mock)
    page.check("#arrowDir"); page.select_option("#dirPalette", "bl"); settle(page)
    other = open_link(ctx, make_link(page, limit=500))
    assert other.is_checked("#arrowDir") and other.input_value("#dirPalette") == "bl", "the canvas link"
    link = make_ids_link(page)
    assert payload_of(link)["view"]["arrowDir"] is True and payload_of(link)["view"]["dirPalette"] == "bl"
    reader = open_ids(ctx, link)
    assert reader.is_checked("#arrowDir") and reader.input_value("#dirPalette") == "bl", "the link of IDs"
