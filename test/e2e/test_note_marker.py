"""On the canvas: a vertex with a note carries a small yellow note, and the VICTIM tag is the threat actor's triangle turned over, in blue."""
import pytest

from conftest import shot
from helpers import click_node, node_ids, settle
from test_pattern_flags import scene

NOTE = (255, 226, 122)
VICTIM_BLUE = (77, 163, 255)
THREAT_RED = (255, 77, 77)


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def quadrants(page, node_id, want, tol=12, half=30, fit=None):
    """How many pixels of one colour sit in each quarter (top/bottom, left/right) of a square round a vertex: `half` pixels from its middle,
    or with `fit` that many radii of the vertex itself, which keeps its tag text (drawn above it in the same colour) out of the square."""
    return page.evaluate("""([id, want, tol, half, fit]) => { const r = window.__hopline.renderer, p = r.positionOf(id), v = r.view, c = r.canvas, dpr = r.dpr;
        if (fit) half = fit * r.data.style.nodeRadius(r.data.graph.nodes.get(id)) * r._scale() + 1;
        const x = Math.round((p.x * v.k + v.x) * dpr), y = Math.round((p.y * v.k + v.y) * dpr), h = Math.round(half * dpr);
        const x0 = Math.max(0, x - h), y0 = Math.max(0, y - h), w = Math.min(c.width - x0, 2 * h), ht = Math.min(c.height - y0, 2 * h);
        const d = c.getContext('2d').getImageData(x0, y0, w, ht).data, q = { tl: 0, tr: 0, bl: 0, br: 0 };
        for (let j = 0; j < ht; j++) for (let i = 0; i < w; i++) {
          const k = (j * w + i) * 4;
          if (Math.abs(d[k] - want[0]) <= tol && Math.abs(d[k + 1] - want[1]) <= tol && Math.abs(d[k + 2] - want[2]) <= tol) q[(y0 + j < y ? 't' : 'b') + (x0 + i < x ? 'l' : 'r')]++;
        }
        return q; }""", [node_id, list(want), tol, half, fit])


def total(q):
    return sum(q.values())


def clear_pointer_and_selection(page):
    page.evaluate("() => window.__hopline.setSel([])")
    page.mouse.move(2, 2)
    settle(page)


def two_apart(page):
    """Two wallets as far from each other as the layout puts them, so one's marker is never inside the other's square."""
    ids = node_ids(page, "addr")
    assert len(ids) >= 2
    pos = page.evaluate("(ids) => ids.map(i => { const p = window.__hopline.renderer.positionOf(i); return [p.x, p.y]; })", ids)
    best = max(((i, j) for i in range(len(ids)) for j in range(i + 1, len(ids))), key=lambda ij: (pos[ij[0]][0] - pos[ij[1]][0]) ** 2 + (pos[ij[0]][1] - pos[ij[1]][1]) ** 2)
    return ids[best[0]], ids[best[1]]


def big_pair(page):
    """The biggest wallet on screen and the biggest one well away from it: a shape large enough to count pixels in, with no neighbour over it."""
    rows = page.evaluate("""() => { const h = window.__hopline, r = h.renderer, v = r.view, s = r._scale();
        return [...h.state.graph.nodes.values()].filter(n => n.type === 'addr').map(n => { const p = r.positionOf(n.id);
          return [n.id, p.x * v.k + v.x, p.y * v.k + v.y, r.data.style.nodeRadius(n) * s]; }); }""")
    rows.sort(key=lambda t: -t[3])
    first = rows[0]
    second = next(t for t in rows[1:] if (t[1] - first[1]) ** 2 + (t[2] - first[2]) ** 2 > 60 ** 2)
    return first[0], second[0]


def test_a_note_puts_a_yellow_note_at_the_lower_right_of_the_vertex_and_clearing_it_takes_it_away(fpage, mock):
    scene(fpage, mock)
    a, b = two_apart(fpage)
    clear_pointer_and_selection(fpage)
    assert total(quadrants(fpage, a, NOTE)) == 0 and total(quadrants(fpage, b, NOTE)) == 0, "no notes, no markers"
    click_node(fpage, a); fpage.fill("#fNote", "seen near the harbour"); settle(fpage)
    clear_pointer_and_selection(fpage)
    q = quadrants(fpage, a, NOTE)
    assert total(q) > 20, q
    assert q["br"] > 0.8 * total(q), "at the lower right of the vertex: %s" % q
    assert total(quadrants(fpage, b, NOTE)) == 0, "only the vertex that has a note"
    shot(fpage, "note_marker.png")
    click_node(fpage, a); fpage.fill("#fNote", ""); settle(fpage)
    clear_pointer_and_selection(fpage)
    assert total(quadrants(fpage, a, NOTE)) == 0, "the marker goes with the note"


def test_a_note_of_only_spaces_is_no_note(fpage, mock):
    scene(fpage, mock)
    a = two_apart(fpage)[0]
    click_node(fpage, a); fpage.fill("#fNote", "    "); settle(fpage)
    clear_pointer_and_selection(fpage)
    assert total(quadrants(fpage, a, NOTE)) == 0


def test_the_victim_tag_is_a_blue_triangle_pointing_down_and_the_threat_tag_a_red_one_pointing_up(fpage, mock):
    scene(fpage, mock)
    victim, threat = big_pair(fpage)
    click_node(fpage, victim); fpage.select_option("#fTag", "VICTIM"); settle(fpage)
    click_node(fpage, threat); fpage.select_option("#fTag", "THREAT"); settle(fpage)
    clear_pointer_and_selection(fpage)
    state = fpage.evaluate("([a, b]) => { const g = window.__hopline.state.graph; return [a, b].map(i => [g.nodes.get(i).tag, g.nodes.get(i).shape, g.nodes.get(i).color]); }", [victim, threat])
    assert state == [["VICTIM", "triangle-down", "#4da3ff"], ["THREAT", "triangle", "#ff4d4d"]]
    shot(fpage, "victim_triangle.png")
    v, t = quadrants(fpage, victim, VICTIM_BLUE, fit=1.25), quadrants(fpage, threat, THREAT_RED, fit=1.25)
    assert total(v) > 40 and total(t) > 40, (v, t)
    assert v["tl"] + v["tr"] > 1.3 * (v["bl"] + v["br"]), "the flat side is on top: %s" % v
    assert t["bl"] + t["br"] > 1.3 * (t["tl"] + t["tr"]), "the point is on top, the wide side below: %s" % t


def test_the_shape_list_offers_the_down_triangle_with_its_own_glyph(fpage, mock):
    scene(fpage, mock)
    click_node(fpage, two_apart(fpage)[0]); settle(fpage)
    options = fpage.eval_on_selector_all("#fShape option", "els => els.map(e => [e.value, e.textContent])")
    assert ["triangle-down", "▼ Triangle (down)"] in options
    assert ["triangle", "▲ Triangle"] in options
