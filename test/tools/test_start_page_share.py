"""What the start page tells a search engine or a chat that shows a preview of its address: a title, a description and a picture of the right size.
The picture is a meta tag, so the page itself still loads nothing from outside."""
import pathlib
import re
import struct

ROOT = pathlib.Path(__file__).resolve().parents[2]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")


def meta(attr, name):
    m = re.search(r'<meta\s+%s="%s"\s+content="([^"]*)"([^>]*)>' % (attr, re.escape(name)), HTML)
    assert m, "the page has no <meta %s=\"%s\">" % (attr, name)
    return m.group(1), m.group(2)


def png_size(path):
    head = path.read_bytes()[:24]
    assert head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR", "%s is a PNG" % path.name
    return struct.unpack(">II", head[16:24])


def test_the_page_has_a_name_and_a_description_that_fit_a_search_result():
    title = re.search(r"<title>([^<]*)</title>", HTML).group(1)
    assert title.startswith("Hopline") and len(title) <= 60, title
    desc = meta("name", "description")[0]
    assert 80 <= len(desc) <= 160, "a description is cut at about 160 characters (%d)" % len(desc)
    assert meta("property", "og:title")[0] == title and meta("property", "og:site_name")[0] == "Hopline" and meta("property", "og:type")[0] == "website"
    assert 50 <= len(meta("property", "og:description")[0]) <= 200
    assert meta("name", "twitter:card")[0] == "summary_large_image"


def test_the_share_picture_exists_has_the_size_the_tags_say_and_is_light_enough():
    src, rest = meta("property", "og:image")
    assert "data-absolute" in rest, "the build makes the address absolute where it knows the address of the site"
    assert re.fullmatch(r"public/[A-Za-z0-9._-]+\.png", src), src
    path = ROOT / src
    assert path.is_file(), src
    w, h = png_size(path)
    assert (w, h) == (1200, 630), "the size chat services show best (a 1.91:1 picture)"
    assert (int(meta("property", "og:image:width")[0]), int(meta("property", "og:image:height")[0])) == (w, h)
    assert path.stat().st_size < 300 * 1024, "%d bytes" % path.stat().st_size
    assert meta("property", "og:image:alt")[0].strip(), "the picture is described"


def test_the_share_tags_load_nothing_by_themselves():
    head = HTML.split("</head>")[0]
    external = re.findall(r'<(?:link|script|img)\b[^>]*(?:href|src)="(https?://[^"]+)"', head)
    assert external == [], external
    assert not re.search(r'<meta\b[^>]*\bhttp-equiv="refresh"', head)
