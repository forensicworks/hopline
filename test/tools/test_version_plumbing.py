"""Each of the three pages carries what the version needs: the style, the script after the settings, one place for the version and one for the bar that offers a reload."""
import pathlib
import re

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
PAGES = {"index.html": ("public/", ""), "public/wallet.html": ("", "../"), "public/workspace.html": ("", "../")}


@pytest.mark.parametrize("page", sorted(PAGES))
def test_the_page_has_the_style_the_script_a_place_for_the_version_and_a_bar(page):
    html = (ROOT / page).read_text(encoding="utf-8")
    prefix, data_root = PAGES[page]
    assert html.count('<link rel="stylesheet" href="%scss/version.css">' % prefix) == 1
    config, script = html.index('<script src="%sconfig.js"></script>' % prefix), html.index('<script src="%sjs/hopline-version.js"></script>' % prefix)
    assert config < script, "the settings are read when the script starts, so they come first"
    assert len(re.findall(r"\bdata-version\b", html)) == 1, "one place for the version"
    bars = re.findall(r'<div id="newVersion" class="versionbar" data-root="([^"]*)"([^>]*)role="status" hidden></div>', html)
    assert len(bars) == 1 and bars[0][0] == data_root, "the bar says where version.json is from this page"
    assert ("data-work" in bars[0][1]) == (page == "public/workspace.html"), "only the workspace warns that a reload costs work"


def test_the_style_file_exists_and_uses_only_variables_the_pages_define():
    css = (ROOT / "public" / "css" / "version.css").read_text(encoding="utf-8")
    used = set(re.findall(r"var\((--[a-z0-9-]+)\)", css))
    for sheet in ("wallet.css", "workspace.css"):
        defined = set(re.findall(r"(--[a-z0-9-]+)\s*:", (ROOT / "public" / "css" / sheet).read_text(encoding="utf-8")))
        assert used <= defined, "%s does not define %s" % (sheet, sorted(used - defined))
