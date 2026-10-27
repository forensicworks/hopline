"""Small helpers shared by the workspace end-to-end tests."""


def show_findings(page):
    """The right-hand panel has two views when something is selected (Details and Findings): turn it to the Findings, opening it if it was folded."""
    page.evaluate("() => window.__hopline.openFindings()")


def idle(page, timeout=15000):
    """Wait until no action is running and the layout animation has finished."""
    page.wait_for_function("() => !window.__hopline.state.busy && !window.__hopline.renderer.anim", timeout=timeout)


def open_query(page, q):
    page.fill("#q", q)
    page.click("#searchForm button[type=submit]")
    page.wait_for_function("() => window.__hopline.state.busy || window.__hopline.state.graph.nodes.size > 0 || !document.getElementById('toast').hidden")
    idle(page)


def node_ids(page, kind=None):
    return page.evaluate(
        "(kind) => [...window.__hopline.state.graph.nodes.values()].filter(n => !kind || n.type === kind).map(n => n.id)", kind)


def counts(page):
    return page.evaluate("() => { const g = window.__hopline.state.graph; const v = window.__hopline.renderer.data && window.__hopline.renderer.data.visible;"
                         " return { nodes: g.nodes.size, edges: g.edges.size, vnodes: v ? v.nodes.size : 0, vedges: v ? v.edges.size : 0 }; }")


def xy(page, node_id):
    """Page coordinates of a vertex on the canvas (for real mouse clicks)."""
    return page.evaluate(
        "(id) => { const r = window.__hopline.renderer, p = r.positionOf(id), v = r.view, b = r.canvas.getBoundingClientRect();"
        " return { x: b.left + p.x * v.k + v.x, y: b.top + p.y * v.k + v.y }; }", node_id)


def click_node(page, node_id, dbl=False):
    p = xy(page, node_id)
    if dbl:
        page.mouse.dblclick(p["x"], p["y"])
    else:
        page.mouse.click(p["x"], p["y"])


def settle(page):
    """Wait for the canvas to finish resizing and refitting after a panel opened or closed (two animation frames, then idle)."""
    page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))")
    idle(page)


def selected(page):
    return page.evaluate("() => [...window.__hopline.state.selected]")


def canvas_has_ink(page):
    """True when the canvas shows something other than the plain background."""
    return page.evaluate("""() => {
      const c = window.__hopline.renderer.canvas, ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const bg = [0x1c, 0x14, 0x1d]; let ink = 0;
      for (let i = 0; i < d.length; i += 4 * 7) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 40) ink++;
      return ink;
    }""")


def toast_text(page):
    return page.evaluate("() => { const t = document.getElementById('toast'); return t.hidden ? '' : t.textContent; }")


def set_slider(page, selector, value):
    page.evaluate("([s, v]) => { const el = document.querySelector(s); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }", [selector, value])


def tick_mode(page, want):
    """The list behind an arrow has one box that rotates on each click: all listed, none, the top few. Click until it is in the mode asked for."""
    box = page.locator("#ctxMenu .tickall")
    for _ in range(4):
        if box.get_attribute("data-mode") == want:
            return
        box.click()
    raise AssertionError("the tick box never reached %r, it is at %r" % (want, box.get_attribute("data-mode")))


def tick_all(page):
    tick_mode(page, "all")


def tick_none(page):
    tick_mode(page, "none")


def tick_top(page):
    tick_mode(page, "top")


def wallet_export(page, kind):
    """Open the wallet page's Export menu and press one item ('csv', 'json' or 'report'). Put it inside expect_download() when a file is expected."""
    if not page.evaluate("() => document.getElementById('exportMenu').open"):
        page.click("#exportMenu summary")
    page.click("[data-export=%s]" % kind)
