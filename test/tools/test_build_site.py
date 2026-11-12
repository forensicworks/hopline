"""The script that builds the published copy: only the pages, the hosted settings and the version, and no damage to what it must not touch."""
import importlib.util
import json
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
    assert '"hosted": true' in cfg and "stats" not in cfg, "nothing is counted"
    assert "hosted" not in text(ROOT / "public" / "config.js").split("*/")[1], "the source file stays empty"


def test_the_source_pages_are_otherwise_copied_unchanged(tmp_path):
    out = tmp_path / "site"
    build_site.build(str(out))
    for rel in ("index.html", "public/wallet.html", "public/workspace.html", "public/js/workspace.js", "public/css/workspace.css"):
        assert (out / rel).read_bytes() == (ROOT / rel).read_bytes(), rel


@pytest.mark.parametrize("kw", [{"version": "a b"}, {"version": "x" * 41},
                                {"code_version": "a b"}, {"code_version": "x" * 41}, {"code_date": "2026-01-03T11:00:00Z"}, {"code_version": "abc1234", "code_date": "yesterday"},
                                {"code_version": "abc1234", "code_date": "2026-01-03 11:00:00"}])
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


def test_a_code_version_is_written_to_version_json_and_to_the_hosted_settings(tmp_path):
    out = tmp_path / "site"
    build_site.build(str(out), version="deploy1", code_version="0e2f471", code_date="2026-11-11T16:58:57Z")
    info = json.loads(text(out / "version.json"))
    assert info == {"version": "0e2f471", "committed": "2026-11-11T16:58:57Z", "about": build_site.ABOUT}, "the code version, not the deploy's own commit used for the script addresses"
    assert '"version": "0e2f471"' in text(out / "public" / "config.js") and "deploy1" not in text(out / "public" / "config.js")
    assert '"committed": "2026-11-11T16:58:57Z"' in text(out / "public" / "config.js"), "the page knows when its own version was committed: that is how it tells a later one from a different one"
    assert 'src="js/workspace.js?v=deploy1"' in text(out / "public" / "workspace.html"), "the address stamp is still the deploy's"
    assert (out / "version.json").read_bytes().endswith(b"}\n") and b"\r" not in (out / "version.json").read_bytes()


def test_without_a_code_version_nothing_about_it_is_written(tmp_path):
    out = tmp_path / "site"
    build_site.build(str(out), version="deploy1")
    assert not (out / "version.json").exists() and "version" not in text(out / "public" / "config.js")


def test_a_code_version_without_a_date_is_written_without_one(tmp_path):
    out = tmp_path / "site"
    build_site.build(str(out), code_version="0e2f471")
    assert json.loads(text(out / "version.json")) == {"version": "0e2f471", "about": build_site.ABOUT}
    assert "committed" not in text(out / "public" / "config.js")


def test_the_version_file_is_never_cached_where_the_host_reads_headers(tmp_path):
    out = tmp_path / "site"
    build_site.build(str(out), code_version="0e2f471")
    lines = text(out / "_headers").splitlines()
    i = lines.index("/version.json")
    assert lines[i + 1] == "  Cache-Control: no-store", lines


def test_the_share_image_gets_an_absolute_address_only_when_the_address_of_the_site_is_given(tmp_path):
    plain = tmp_path / "plain"
    build_site.build(str(plain))
    assert 'content="public/share.png"' in text(plain / "index.html"), "the open edition keeps it relative"
    source = text(ROOT / "index.html")
    for given, root in (("https://hopline.pages.dev", "https://hopline.pages.dev/"), ("https://hopline.pages.dev/", "https://hopline.pages.dev/"),
                        ("https://owner.github.io/hopline", "https://owner.github.io/hopline/"), ("https://owner.github.io/hopline/", "https://owner.github.io/hopline/")):
        out = tmp_path / ("s" + str(abs(hash(given))))
        build_site.build(str(out), site_url=given)
        html = text(out / "index.html")
        assert '<meta property="og:image" content="%spublic/share.png"' % root in html, given
        assert html == source.replace('content="public/share.png"', 'content="%spublic/share.png"' % root), "nothing else in the page changes"
        for rel in ("public/wallet.html", "public/workspace.html"):
            assert (out / rel).read_bytes() == (ROOT / rel).read_bytes(), rel


@pytest.mark.parametrize("bad", ["http://hopline.pages.dev", "hopline.pages.dev", "https://x.example/?a=1", "https://x.example/#a", "https://user@x.example", "https://x.example/a b",
                                 "https://x.example/../y", "https://x.example/./y", "https://x.example/\"q", "ftp://x.example", "https://"])
def test_a_site_address_that_is_not_a_plain_https_address_is_refused(tmp_path, bad):
    with pytest.raises(SystemExit, match="--site-url"):
        build_site.build(str(tmp_path / "site"), site_url=bad)


def test_both_deploys_tell_the_build_where_the_site_lives():
    deploy = text(ROOT / ".github" / "workflows" / "deploy.yml")
    pages = text(ROOT / ".github" / "workflows" / "pages.yml")
    assert '--site-url "https://${PAGES_PROJECT}.pages.dev"' in deploy and "PAGES_PROJECT: hopline" in deploy
    assert '--site-url "https://${OWNER,,}.github.io/${REPO_NAME}"' in pages and "OWNER: ${{ github.repository_owner }}" in pages


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
