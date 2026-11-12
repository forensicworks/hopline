"""The assistant talks only to a model on this computer: no hosted option, no key box, and a whole session of copying, testing, asking and checking makes no request
that does not go to the model server on 127.0.0.1 (answered here, never for real)."""
import pytest

from chains import tid
from helpers import settle
from test_assistant import MODEL_URL, capture, chat, model_server, open_ai, set_model
from test_pattern_flags import scene


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def test_the_assistant_section_has_no_hosted_option_and_no_key_box(fpage, mock):
    scene(fpage, mock); open_ai(fpage, local=True)
    box = fpage.evaluate("""() => { const s = document.getElementById('aiSection');
        return { text: s.textContent.toLowerCase(), passwords: s.querySelectorAll('input[type=password]').length, outbound: s.querySelectorAll('.outbound, .outbound-btn, .review').length }; }""")
    assert box["passwords"] == 0 and box["outbound"] == 0, box
    for word in ("claude", "anthropic", "api key", "openai api", "gemini", "sends the evidence to"):
        assert word not in box["text"], word


def test_a_whole_session_with_the_assistant_only_ever_talks_to_the_model_on_this_computer(fpage, mock):
    scene(fpage, mock); capture(fpage)
    server = model_server(fpage, chat("The chain starts at %s." % tid(10)), models=["llama3.1", "qwen3"])
    set_model(fpage)
    origin = fpage.evaluate("() => location.origin")
    seen = []
    fpage.on("request", lambda r: seen.append(r.url) if r.url.startswith("http") else None)
    fpage.click("#aiCopy"); fpage.click("#aiTest"); settle(fpage)
    fpage.select_option("#aiTask", "ask"); fpage.fill("#aiQuestion", "Where did the money go next?")
    fpage.click("#aiAsk"); fpage.wait_for_function("() => document.getElementById('aiText').value !== ''")
    fpage.click("#aiCheck"); settle(fpage)
    assert len(server) == 2, "the model list and the question: " + str([s["url"] for s in server])
    elsewhere = [u for u in seen if not u.startswith(MODEL_URL + "/") and not u.startswith(origin)]
    assert elsewhere == [], elsewhere
