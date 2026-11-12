"""Hopline counts nothing: no visit counter and no analytics, on any copy. The pages, scripts, styles, build tools and workflows are checked for the
names of counting services and of the counter that used to be here, so one cannot come back by accident. (Data files are not checked: a label may
be called anything.) If you really want a counter, change this test on purpose and say so in the README, SECURITY.md and the start page."""
import pathlib

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]

FORBIDDEN = ["goatcounter", "hopline-stats", "hoplinestats", "data-counter", "counterbar", "stats-code", "stats-endpoint", "google-analytics", "googletagmanager",
             "gtag(", "plausible.io", "matomo", "posthog", "hotjar", "umami.is", "simpleanalytics", "cloudflareinsights", "segment.com/analytics"]


def sources():
    out = [ROOT / "index.html", ROOT / "public" / "config.js"]
    for pattern in ("public/*.html", "public/js/*.js", "public/css/*.css", "tools/*.py", "tools/*.js", ".github/workflows/*.yml"):
        out += sorted(ROOT.glob(pattern))
    return [p for p in out if p.is_file()]


def test_the_list_of_files_that_are_checked_is_not_empty():
    names = {p.name for p in sources()}
    assert {"index.html", "workspace.html", "wallet.html", "workspace.js", "build_site.py", "deploy.yml", "pages.yml", "config.js"} <= names, names


@pytest.mark.parametrize("path", sources(), ids=lambda p: p.relative_to(ROOT).as_posix())
def test_no_page_script_style_tool_or_workflow_names_a_counting_service(path):
    text = path.read_text(encoding="utf-8").lower()
    found = [w for w in FORBIDDEN if w in text]
    assert not found, "%s mentions %s: Hopline counts nothing" % (path.relative_to(ROOT).as_posix(), found)


def test_the_build_has_no_option_for_counting_and_writes_no_counting_settings(tmp_path):
    import importlib.util
    spec = importlib.util.spec_from_file_location("build_site", ROOT / "tools" / "build_site.py")
    build_site = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build_site)
    with pytest.raises(SystemExit):
        build_site.main(["--out", str(tmp_path / "a"), "--stats-code", "my-site"])
    with pytest.raises(TypeError):
        build_site.build(str(tmp_path / "b"), stats_code="my-site")
    build_site.build(str(tmp_path / "c"), version="abc1234", base_path="/hopline/", code_version="abc1234", code_date="2026-11-12T00:00:00Z", site_url="https://owner.github.io/hopline")
    config = (tmp_path / "c" / "public" / "config.js").read_text(encoding="utf-8")
    assert "stats" not in config and "endpoint" not in config, config
    for page in ("index.html", "public/wallet.html", "public/workspace.html"):
        html = (tmp_path / "c" / page).read_text(encoding="utf-8").lower()
        assert "visit counter" not in html and "counts visits" not in html and "do not track" not in html, page


def test_the_workflows_pass_nothing_about_counting_to_the_build():
    for name in ("deploy.yml", "pages.yml"):
        wf = (ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8")
        assert "build_site.py --out site" in wf and "--stats" not in wf and "GOATCOUNTER" not in wf.upper(), name
