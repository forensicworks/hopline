"""The local static server: no caching, the right file types, this computer only, and read-only."""
import http.client
import importlib.util
import pathlib
import threading

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("serve", ROOT / "tools" / "serve.py")
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


@pytest.fixture
def server(tmp_path):
    (tmp_path / "a.js").write_text("var x = 1;", encoding="utf-8")
    (tmp_path / "b.css").write_text("body{}", encoding="utf-8")
    (tmp_path / "c.html").write_text("<p>hi</p>", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("outside", encoding="utf-8")
    web = tmp_path / "web"; web.mkdir()
    (web / "index.html").write_text("<p>home</p>", encoding="utf-8")
    (web / "app.js").write_text("1", encoding="utf-8")
    srv = serve.make_server(str(web), 0)
    t = threading.Thread(target=srv.serve_forever, daemon=True); t.start()
    yield srv
    srv.shutdown(); srv.server_close()


def get(srv, path, method="GET"):
    c = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=5)
    c.request(method, path)
    r = c.getresponse(); body = r.read()
    return r, body


def test_it_listens_on_this_computer_only(server):
    assert server.server_address[0] == "127.0.0.1"


def test_every_answer_tells_the_browser_to_keep_no_copy(server):
    for path in ("/index.html", "/app.js", "/missing.js"):
        r, _ = get(server, path)
        assert r.getheader("Cache-Control") == "no-store", path


def test_the_file_types_are_named_by_the_server_not_by_the_registry(server):
    assert get(server, "/app.js")[0].getheader("Content-Type").startswith("text/javascript")
    assert get(server, "/index.html")[0].getheader("Content-Type").startswith("text/html")
    assert serve.Handler.extensions_map[".css"].startswith("text/css")
    assert serve.Handler.extensions_map[".png"] == "image/png"


def test_it_serves_the_folder_and_nothing_above_it(server):
    r, body = get(server, "/")
    assert r.status == 200 and b"home" in body
    assert get(server, "/app.js")[1] == b"1"
    assert get(server, "/missing")[0].status == 404
    for evil in ("/../secret.txt", "/..%2fsecret.txt", "/%2e%2e/secret.txt", "/..\\secret.txt"):
        r, body = get(server, evil)
        assert r.status in (301, 400, 403, 404) and b"outside" not in body, evil


def test_it_only_reads(server):
    r, _ = get(server, "/index.html", method="POST")
    assert r.status in (501, 405)
    r, _ = get(server, "/index.html", method="PUT")
    assert r.status in (501, 405)


def test_the_default_folder_is_the_repository_and_a_port_that_cannot_be_used_is_reported_not_crashed(monkeypatch, capsys):
    assert serve.ROOT == str(ROOT)
    def refuse(directory, port):
        raise OSError("address already in use")
    monkeypatch.setattr(serve, "make_server", refuse)
    assert serve.main(["--port", "8000"]) == 1
    assert "Try another port" in capsys.readouterr().err
