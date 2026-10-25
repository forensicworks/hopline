"""Every page links to the project's source code and its licence."""
import pytest

from conftest import PAGE_URL, ROOT

REPO = "https://github.com/forensicworks/hopline"
PAGES = {"start page": (ROOT / "index.html").as_uri(), "wallet page": (ROOT / "public" / "wallet.html").as_uri(), "workspace": PAGE_URL}


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


@pytest.mark.parametrize("name", sorted(PAGES))
def test_each_page_links_to_the_source_and_the_licence_safely(ctx, errors, name):
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(PAGES[name])
    links = p.eval_on_selector_all("a[href^='%s']" % REPO, "els => els.map(e => [e.getAttribute('href'), e.getAttribute('target'), e.getAttribute('rel'), e.textContent.trim()])")
    hrefs = [l[0] for l in links]
    assert REPO in hrefs and REPO + "/wiki" in hrefs and REPO + "/blob/master/LICENSE" in hrefs, hrefs
    for href, target, rel, text in links:
        assert target == "_blank" and rel == "noopener noreferrer", (href, target, rel)
        assert text, "a link with words"
    p.close()


def test_the_visible_pages_show_the_link_without_opening_anything(ctx, errors):
    for name in ("start page", "wallet page"):
        p = ctx.new_page(); p.on("pageerror", lambda e: errors.append(str(e)))
        p.goto(PAGES[name])
        assert p.locator("a[href='%s']" % REPO).first.is_visible(), name
        p.close()
