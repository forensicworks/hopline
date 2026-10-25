"""The script that builds the published copy: only the pages, the hosted settings, the optional counter and version, and no damage to what it must not touch."""
import importlib.util
import pathlib

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("build_site", ROOT / "tools" / "build_site.py")
build_site = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_site)


def text(p):
    return pathlib.Path(p).read_text(encoding="utf-8")


def test_only_the_pages_are_published_and_the_copy_is_marked_hosted(tmp_path):
    out = tmp_path / "site"
    build_site.build(str(out))
    names = {p.name for p in out.iterdir()}
    assert names == {"index.html", "LICENSE", "NOTICE", "public", ".nojekyll", "_headers", "404.html"}, names
    assert (out / "public" / "js" / "workspace.js").is_file() and (out / "public" / "workspace.html").is_file() and (out / "public" / "data" / "known-addresses.js").is_file()
    cfg = text(out / "public" / "config.js")
    assert '"hosted": true' in cfg and "stats" not in cfg, "no counting unless asked"
    assert "hosted" not in text(ROOT / "public" / "config.js").split("*/")[1], "the source file stays empty"


def test_the_source_pages_are_otherwise_copied_unchanged(tmp_path):
    out = tmp_path / "site"
    build_site.build(str(out))
    for rel in ("index.html", "public/wallet.html", "public/workspace.html", "public/js/workspace.js", "public/css/workspace.css"):
        assert (out / rel).read_bytes() == (ROOT / rel).read_bytes(), rel


def test_a_goatcounter_code_becomes_the_counting_address(tmp_path):
    out = tmp_path / "site"
    r = build_site.build(str(out), stats_code="my-site")
    assert r["stats"] == "https://my-site.goatcounter.com/count"
    assert '"endpoint": "https://my-site.goatcounter.com/count"' in text(out / "public" / "config.js")
    build_site.build(str(out), stats_endpoint="https://stats.example.org/count")
    assert "https://stats.example.org/count" in text(out / "public" / "config.js")


@pytest.mark.parametrize("kw", [{"stats_code": "Bad Code"}, {"stats_code": "a"}, {"stats_code": "x/../y"}, {"stats_endpoint": "http://stats.example/count"},
                                {"stats_endpoint": "https://stats.example/count?site=1"}, {"stats_endpoint": "https://user@stats.example/count"},
                                {"stats_code": "ok", "stats_endpoint": "https://stats.example/count"}, {"version": "a b"}, {"version": "x" * 41}])
def test_odd_input_is_refused_before_anything_is_written(tmp_path, kw):
    out = tmp_path / "site"
    with pytest.raises(SystemExit):
        build_site.build(str(out), **kw)
    assert not out.exists()


def test_a_version_is_added_to_every_local_script_and_style_but_not_to_other_links(tmp_path):
    out = tmp_path / "site"
    build_site.build(str(out), version="abc123")
    ws = text(out / "public" / "workspace.html")
    assert '<script src="config.js?v=abc123"></script>' in ws and '<script src="js/workspace.js?v=abc123"></script>' in ws and '<script src="data/known-addresses.js?v=abc123"></script>' in ws
    assert 'href="css/workspace.css?v=abc123"' in ws
    local = [l for l in ws.splitlines() if 'src="js/' in l or 'src="data/' in l or 'src="config.js' in l]
    assert len(local) > 20 and all("?v=abc123" in l for l in local), "every script of the page"
    idx = text(out / "index.html")
    assert 'src="public/config.js?v=abc123"' in idx and 'href="public/css/wallet.css?v=abc123"' in idx
    assert 'href="public/workspace.html"' in idx, "a link to a page is not versioned"
    assert "?v=" not in text(ROOT / "index.html"), "the source is not touched"


def test_the_shipped_packs_are_published_and_the_list_of_them_is_versioned(tmp_path):
    out = tmp_path / "site"
    build_site.build(str(out), version="abc123")
    assert (out / "public" / "packs" / "index.js").is_file() and (out / "public" / "packs" / "ofac-sdn.js").is_file()
    for page in ("workspace.html", "wallet.html"):
        html = text(out / "public" / page)
        assert '<script src="packs/index.js?v=abc123"></script>' in html and '<script src="js/hopline-packs.js?v=abc123"></script>' in html, page
    assert "?v=" not in text(ROOT / "public" / "workspace.html"), "the source is not touched"


def test_it_will_not_empty_the_repository_or_a_folder_above_it(tmp_path):
    for bad in (str(ROOT), str(ROOT.parent)):
        with pytest.raises(SystemExit):
            build_site.build(bad)
    assert (ROOT / "index.html").is_file() and (ROOT / "public" / "workspace.html").is_file()


def test_an_existing_output_is_replaced_but_its_git_folder_is_kept(tmp_path):
    out = tmp_path / "site"
    (out / ".git").mkdir(parents=True); (out / ".git" / "HEAD").write_text("ref: refs/heads/main", encoding="utf-8")
    (out / "old.html").write_text("stale", encoding="utf-8"); (out / "public").mkdir(); (out / "public" / "gone.js").write_text("x", encoding="utf-8")
    build_site.build(str(out))
    assert (out / ".git" / "HEAD").is_file() and not (out / "old.html").exists() and not (out / "public" / "gone.js").exists()


def test_the_headers_file_asks_for_no_referrer_no_sniffing_and_no_framing(tmp_path):
    out = tmp_path / "site"
    build_site.build(str(out))
    h = (out / "_headers").read_bytes().decode("utf-8")
    lines = h.splitlines()
    assert lines[0] == "/*" and "  Referrer-Policy: no-referrer" in lines and "  X-Content-Type-Options: nosniff" in lines and "  Content-Security-Policy: frame-ancestors 'none'" in lines
    assert chr(13) not in h and len(lines) < 100, "plain lines, well inside the host's limit of 100 rules"


def test_the_404_page_links_back_to_where_the_site_lives(tmp_path):
    out = tmp_path / "site"
    build_site.build(str(out))
    assert '<a href="/">Back to Hopline</a>' in text(out / "404.html"), "the default: the site is at the root of its host"
    build_site.build(str(out), base_path="/hopline/")
    assert '<a href="/hopline/">Back to Hopline</a>' in text(out / "404.html") and "@BASE@" not in text(out / "404.html")
    build_site.build(str(out), base_path="/hopline")
    assert '<a href="/hopline/">' in text(out / "404.html"), "a missing trailing slash is added"


@pytest.mark.parametrize("bad", ["hopline/", "//evil.com/", "/a b/", "/a?x=1/", "/../", "/./", "/%2e%2e/", "/x/../y/", "https://evil.com/", ""])
def test_a_base_path_that_is_not_a_plain_path_is_refused_before_anything_is_written(tmp_path, bad):
    out = tmp_path / "site"
    with pytest.raises(SystemExit):
        build_site.build(str(out), base_path=bad)
    assert not out.exists()
