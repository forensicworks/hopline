"""Assistant, the Claude option: off when the page opens, the exact text shown before anything is sent, and one request to api.anthropic.com (answered here, never for real)."""
import json
import re

import pytest

from chains import tid
from conftest import shot
from helpers import settle
from test_assistant import FAKE, MODEL_URL, browser_noise, capture, evidence, model_server, open_ai, result, set_model
from test_pattern_flags import CHAIN_LABEL, scene

API = "https://api.anthropic.com"


def names_host(text):
    """The words on the page name the Anthropic host (a check on what the page says, not on a URL)."""
    return re.search(r"\bapi\.anthropic\.com\b", text) is not None
KEY = "sk-ant-api03-" + "k" * 30
CORS = {"access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access"}


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def message(text, stop="end_turn", model="claude-opus-5-5", content=None, **extra):
    """A reply of the Messages API: an empty thinking block (the default display) and the text."""
    return {"id": "msg_1", "type": "message", "role": "assistant", "model": model, "stop_reason": stop, "usage": {"input_tokens": 4210, "output_tokens": 880},
            "content": content or [{"type": "thinking", "thinking": ""}, {"type": "text", "text": text}], **extra}


def api_error(kind, text):
    return {"type": "error", "error": {"type": kind, "message": text}, "request_id": "req_1"}


def claude_server(page, reply=None, status=200, models=None, hold=None):
    """api.anthropic.com. Every real request is recorded in the returned list; `hold` collects requests that are left unanswered."""
    seen = []

    def handle(route):
        req = route.request
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        seen.append({"method": req.method, "url": req.url, "headers": req.headers, "body": req.post_data})
        if hold is not None:
            hold.append(route)
            return
        if reply == "down":
            return route.abort()
        if req.method == "GET" and "/v1/models" in req.url:
            return route.fulfill(status=status, headers={**CORS, "content-type": "application/json"}, body=json.dumps({"data": [{"id": m} for m in (models or [])], "has_more": False}) if status == 200 else json.dumps(reply))
        body = reply if isinstance(reply, str) else json.dumps(reply)
        route.fulfill(status=status, headers={**CORS, "content-type": "application/json"}, body=body)

    page.route(API + "/**", handle)
    return seen


def open_claude(page, key=KEY, model=None, on=True):
    open_ai(page)
    page.evaluate("() => { document.getElementById('aiClaude').open = true; }")
    if on:
        page.check("#claudeOn")
    if key is not None:
        page.fill("#claudeKey", key)
    if model is not None:
        page.fill("#claudeModel", model)


def review(page):
    """Press Ask Claude… and return the text the review shows."""
    page.click("#claudeAsk")
    page.wait_for_selector("#claudeReview", state="visible")
    return page.text_content("#claudeReviewText")


def ask(page):
    """The whole round: ask, read, confirm, wait for the answer box to fill."""
    text = review(page)
    page.click("#claudeSend")
    page.wait_for_function("() => document.getElementById('aiText').value !== ''")
    return text


def note(page):
    return page.inner_text("#aiNote")


def ready(page):
    page.wait_for_function("() => document.getElementById('claudeAsk').textContent === 'Ask Claude…' && !document.getElementById('claudeAsk').disabled")


# ---- off by default, and marked wherever it is on --------------------------------------------------------------------------------

def test_the_claude_option_is_off_when_the_page_opens_and_nothing_goes_to_anthropic(fpage, mock):
    scene(fpage, mock); capture(fpage); open_ai(fpage)
    outside = []
    fpage.on("request", lambda r: outside.append(r.url) if r.url.startswith("http") and "/api/" not in r.url else None)
    server = claude_server(fpage, message("x"))
    assert fpage.is_hidden("#claudeBody") and fpage.is_hidden("#claudeFlag") and fpage.is_hidden("#claudeBadge") and fpage.is_hidden("#claudeAsk")
    assert not fpage.is_checked("#claudeOn")
    fpage.click("#aiCopy"); fpage.fill("#aiText", "see " + tid(10)); fpage.click("#aiCheck"); settle(fpage)
    assert outside == [] and server == [], "copying and checking never touch Anthropic"
    assert "switch on the Claude option" in fpage.inner_text("#aiSection .sec > p.hint")


def test_switching_it_on_shows_the_marker_in_the_panel_and_in_the_closed_heading_and_off_removes_it(fpage, mock):
    scene(fpage, mock); open_ai(fpage)
    fpage.evaluate("() => { document.getElementById('aiClaude').open = true; }")
    fpage.check("#claudeOn")
    assert fpage.is_visible("#claudeFlag") and "Claude is on" in fpage.inner_text("#claudeFlag") and names_host(fpage.inner_text("#claudeFlag"))
    assert fpage.is_visible("#claudeBadge") and fpage.is_visible("#claudeBody") and fpage.is_visible("#claudeAsk")
    fpage.evaluate("() => { document.getElementById('aiSection').open = false; }")
    assert fpage.is_visible("#claudeBadge"), "the heading says it even when the section is closed"
    fpage.evaluate("() => { document.getElementById('aiSection').open = true; }")
    fpage.uncheck("#claudeOn")
    assert fpage.is_hidden("#claudeFlag") and fpage.is_hidden("#claudeBadge") and fpage.is_hidden("#claudeBody")
    assert "Claude option switched off" in fpage.text_content("#logList")


def test_it_is_off_again_after_a_reload_even_if_it_was_on(fpage, mock):
    scene(fpage, mock); open_claude(fpage)
    assert fpage.is_visible("#claudeFlag")
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    open_ai(fpage); fpage.evaluate("() => { document.getElementById('aiClaude').open = true; }")
    assert not fpage.is_checked("#claudeOn") and fpage.is_hidden("#claudeFlag") and fpage.is_hidden("#claudeBadge") and fpage.is_hidden("#claudeBody")
    assert fpage.input_value("#claudeKey") == "", "the key was not kept"


def test_ask_needs_a_valid_key_and_a_model(fpage, mock):
    scene(fpage, mock)
    server = claude_server(fpage, message("x"))
    open_claude(fpage, key="")
    assert fpage.is_disabled("#claudeAsk") and fpage.is_disabled("#claudeTest") and "API key" in fpage.get_attribute("#claudeAsk", "title")
    fpage.fill("#claudeKey", "short"); assert fpage.is_disabled("#claudeAsk")
    fpage.fill("#claudeKey", "sk-ant has a space in it"); assert fpage.is_disabled("#claudeAsk")
    fpage.fill("#claudeKey", KEY); assert fpage.is_enabled("#claudeAsk") and fpage.is_enabled("#claudeTest")
    fpage.fill("#claudeModel", ""); assert fpage.is_disabled("#claudeAsk") and "Name the model" in fpage.get_attribute("#claudeAsk", "title")
    fpage.evaluate("() => document.getElementById('claudeAsk').click()"); settle(fpage)
    assert server == [] and fpage.is_hidden("#claudeReview")
    fpage.fill("#claudeModel", "claude-sonnet-5-5"); assert fpage.is_enabled("#claudeAsk")


# ---- the review: the exact text, and nothing sent until the click ----------------------------------------------------------------

def test_asking_shows_the_exact_text_and_sends_nothing_until_it_is_confirmed(fpage, mock):
    scene(fpage, mock)
    server = claude_server(fpage, message("x"))
    open_claude(fpage)
    text = review(fpage)
    assert text.startswith("You are helping an investigator read the output of a Bitcoin transaction analysis tool.") and "Use only the EVIDENCE" in text and "TASK: Triage" in text
    assert evidence(text)["peelChains"][0]["name"] == CHAIN_LABEL
    meta = fpage.inner_text("#claudeReviewMeta")
    assert "leaves your computer" in meta and names_host(meta) and "claude-opus-5-5" in meta and "pattern rows" in meta
    assert fpage.evaluate("() => { const e = document.getElementById('claudeReviewText'); return [e.tagName, e.isContentEditable]; }") == ["PRE", False], "a block of text, not a field that could be edited"
    assert fpage.locator("textarea[readonly]").count() == 0, "no read-only field for the page's other helpers to trip over"
    settle(fpage)
    assert server == [], "the text is shown, not sent"
    fpage.click("#claudeCancel")
    assert fpage.is_hidden("#claudeReview"); settle(fpage)
    assert server == [] and fpage.input_value("#aiText") == ""


def test_confirming_sends_one_request_with_exactly_the_text_that_was_shown(fpage, mock):
    scene(fpage, mock)
    answer = "The chain starts at %s and the third step is %s.\n\nIt also touched %s." % (tid(10), tid(12), FAKE)
    server = claude_server(fpage, message(answer))
    open_claude(fpage)
    shown = ask(fpage)
    assert fpage.input_value("#aiText") == answer
    assert len(server) == 1
    req = server[0]
    assert req["method"] == "POST" and req["url"] == API + "/v1/messages"
    h = req["headers"]
    assert h["x-api-key"] == KEY and h["anthropic-version"] == "2026-10-21" and h["anthropic-dangerous-direct-browser-access"] == "true" and h["anthropic-beta"] == "server-side-fallback-2026-07-01"
    body = json.loads(req["body"])
    assert body["model"] == "claude-opus-5-5" and body["max_tokens"] == 16000 and body["fallbacks"] == "default"
    assert not {"temperature", "top_p", "top_k", "thinking", "stream"} & set(body)
    assert [m["role"] for m in body["messages"]] == ["user"]
    assert body["system"] + "\n\n" + body["messages"][0]["content"] == shown, "what was sent is what the review showed"
    assert KEY not in req["body"], "the key is a header and nothing else"
    n = note(fpage)
    assert "Written by claude-opus-5-5 (Claude, through Anthropic)" in n and "4,210 tokens in and 880 out" in n and "not evidence" in n
    fpage.wait_for_function("() => document.getElementById('aiResult').innerText.includes('NOT in this workspace')")
    assert "1 id is NOT in this workspace" in result(fpage) and FAKE in result(fpage), "the same id check as for any other answer"
    log = fpage.text_content("#logList")
    assert "Asked Claude claude-opus-5-5" in log and "sent to api.anthropic.com" in log
    ready(fpage)


def test_what_is_sent_is_what_was_shown_even_when_the_workspace_changes_while_the_review_is_open(fpage, mock):
    scene(fpage, mock)
    server = claude_server(fpage, message("see " + tid(10)))
    open_claude(fpage)
    shown = review(fpage)
    fpage.evaluate("""(id) => { const n = window.__hopline.state.graph.nodes.get(id); n.label = 'CHANGED-AFTER-THE-REVIEW'; window.__hopline.refresh(); }""", "addr:bc1q" + "peel10".ljust(20, "x"))
    fpage.click("#claudeSend"); fpage.wait_for_function("() => document.getElementById('aiText').value !== ''")
    body = json.loads(server[0]["body"])
    assert body["system"] + "\n\n" + body["messages"][0]["content"] == shown and "CHANGED-AFTER-THE-REVIEW" not in server[0]["body"]


@pytest.mark.parametrize("what", ["task", "rows", "model", "key", "switch"])
def test_changing_anything_the_review_was_made_from_withdraws_it_and_sends_nothing(fpage, mock, what):
    scene(fpage, mock)
    server = claude_server(fpage, message("x"))
    open_claude(fpage); review(fpage)
    if what == "task":
        fpage.select_option("#aiTask", "narrative")
    elif what == "rows":
        fpage.fill("#aiRows", "10"); fpage.dispatch_event("#aiRows", "change")
    elif what == "model":
        fpage.fill("#claudeModel", "claude-sonnet-5-5")
    elif what == "key":
        fpage.fill("#claudeKey", KEY + "x")
    else:
        fpage.uncheck("#claudeOn")
    assert fpage.is_hidden("#claudeReview"); settle(fpage)
    assert server == []


def test_each_task_and_the_model_chosen_are_in_what_is_shown(fpage, mock):
    scene(fpage, mock)
    claude_server(fpage, message("x"))
    open_claude(fpage, model="claude-sonnet-5-5")
    fpage.select_option("#aiTask", "challenge")
    assert "TASK: Challenge the findings" in review(fpage) and "claude-sonnet-5-5" in fpage.inner_text("#claudeReviewMeta")
    fpage.select_option("#aiTask", "explain")
    fpage.evaluate("() => window.__hopline.setSel([])"); settle(fpage)
    fpage.click("#claudeAsk")
    assert "Select a transaction or a wallet first" in fpage.inner_text("#toast")


def test_a_model_without_the_refusal_fallback_is_sent_without_it(fpage, mock):
    scene(fpage, mock)
    server = claude_server(fpage, message("see " + tid(10), model="claude-haiku-5-5"))
    open_claude(fpage, model="claude-haiku-5-5"); ask(fpage)
    assert "fallbacks" not in json.loads(server[0]["body"]) and "anthropic-beta" not in server[0]["headers"]


# ---- keeping the key -------------------------------------------------------------------------------------------------------------

def test_the_key_is_not_stored_anywhere_unless_asked(fpage, mock):
    scene(fpage, mock)
    claude_server(fpage, message("see " + tid(10)))
    open_claude(fpage, model="claude-opus-5-5"); ask(fpage)
    saved = fpage.evaluate("() => JSON.stringify(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]))")
    assert KEY not in saved and "hopline.claude.key" not in saved
    prefs = json.loads(fpage.evaluate("() => localStorage.getItem('hopline.prefs.v1')"))
    assert prefs["claude"] == {"model": "claude-opus-5-5", "remember": False}
    assert prefs["assist"] == {"endpoint": MODEL_URL, "model": "", "rows": 60}, "the local-model settings are as they were"
    assert KEY not in fpage.evaluate("() => JSON.stringify([window.__hopline.state.assist, window.__hopline.state.claude])") and KEY not in fpage.text_content("#logList")


def test_remember_keeps_the_key_under_its_own_name_and_unticking_forgets_it(fpage, mock):
    scene(fpage, mock)
    open_claude(fpage); fpage.check("#claudeRemember")
    assert fpage.evaluate("() => localStorage.getItem('hopline.claude.key')") == KEY
    prefs = json.loads(fpage.evaluate("() => localStorage.getItem('hopline.prefs.v1')"))
    assert prefs["claude"]["remember"] is True and KEY not in json.dumps(prefs), "the prefs say it is remembered, and hold no key"
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    open_ai(fpage); fpage.evaluate("() => { document.getElementById('aiClaude').open = true; }")
    assert not fpage.is_checked("#claudeOn"), "remembering the key does not switch the option on"
    fpage.check("#claudeOn")
    assert fpage.input_value("#claudeKey") == KEY and fpage.is_checked("#claudeRemember")
    fpage.uncheck("#claudeRemember")
    assert fpage.evaluate("() => localStorage.getItem('hopline.claude.key')") is None
    fpage.check("#claudeRemember"); fpage.fill("#claudeKey", "")
    assert fpage.evaluate("() => localStorage.getItem('hopline.claude.key')") is None, "an emptied key is not kept"


def test_the_model_name_is_remembered(fpage, mock):
    scene(fpage, mock)
    open_claude(fpage, model="claude-sonnet-5-5")
    fpage.reload(); fpage.wait_for_function("window.__hopline && window.__hopline.renderer")
    open_ai(fpage); fpage.evaluate("() => { document.getElementById('aiClaude').open = true; }")
    assert fpage.input_value("#claudeModel") == "claude-sonnet-5-5"
    fpage.check("#claudeOn")
    fpage.fill("#claudeModel", ""); fpage.dispatch_event("#claudeModel", "blur")
    assert fpage.input_value("#claudeModel") == "claude-opus-5-5", "an emptied name goes back to the default"


# ---- what comes back -------------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("reply,status,words", [
    (api_error("authentication_error", "invalid x-api-key"), 401, 'did not accept the key (401)'),
    (api_error("rate_limit_error", "Number of requests exceeded"), 429, "limiting requests"),
    (api_error("overloaded_error", "Overloaded"), 529, "overloaded"),
    (api_error("invalid_request_error", "Your credit balance is too low"), 400, 'It said: "Your credit balance is too low"'),
    ("boom", 500, 'Anthropic had an error (500)'),
    ("<html>", 200, "not JSON"),
    (api_error("overloaded_error", "Overloaded"), 200, "Anthropic said: Overloaded"),
    (message("", stop="refusal", content=[], stop_details={"type": "refusal", "category": "cyber", "explanation": None}), 200, "declined this request (cyber)"),
    (message("", content=[{"type": "thinking", "thinking": ""}]), 200, "Claude sent no text"),
    ("down", 200, "Could not reach api.anthropic.com"),
])
def test_a_failure_is_told_in_words_and_the_answer_box_is_left_alone(fpage, mock, errors, reply, status, words):
    scene(fpage, mock)
    claude_server(fpage, reply, status=status)
    open_claude(fpage); fpage.fill("#aiText", "my own notes")
    review(fpage); fpage.click("#claudeSend")
    fpage.wait_for_function("(w) => document.getElementById('aiNote').innerText.includes(w)", arg=words)
    assert fpage.input_value("#aiText") == "my own notes" and "bad" in (fpage.get_attribute("#aiNote", "class") or "")
    ready(fpage); assert fpage.is_hidden("#claudeReview")
    browser_noise(errors)


def test_an_answer_that_ran_out_of_room_is_marked_as_cut_off_and_still_checked(fpage, mock):
    scene(fpage, mock)
    answer = "The chain starts at %s and then" % tid(10)
    claude_server(fpage, message(answer, stop="max_tokens"))
    open_claude(fpage); ask(fpage)
    text = fpage.input_value("#aiText")
    assert text.startswith(answer) and text.rstrip().endswith("[Cut off: Claude stopped before it finished.]"), "the marker travels with the text"
    n = note(fpage)
    assert "ran out of room" in n and "16,000 tokens" in n and "bad" in (fpage.get_attribute("#aiNote", "class") or "")
    fpage.wait_for_function("() => document.getElementById('aiResult').innerText.includes('Every id it cites')")


def test_when_a_second_model_answered_after_a_decline_only_its_text_is_used_and_it_is_said(fpage, mock):
    scene(fpage, mock)
    claude_server(fpage, message("", model="claude-opus-4-8", content=[{"type": "text", "text": "I cannot help"}, {"type": "fallback", "from": {"model": "claude-opus-5-5"}, "to": {"model": "claude-opus-4-8"}},
                                                                    {"type": "text", "text": "The chain starts at %s." % tid(10)}]))
    open_claude(fpage); ask(fpage)
    assert fpage.input_value("#aiText") == "The chain starts at %s." % tid(10)
    n = note(fpage)
    assert "Written by claude-opus-4-8" in n and "second Anthropic model answered" in n


def test_the_answer_is_only_ever_shown_as_text(fpage, mock):
    scene(fpage, mock)
    evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script> see %s' % tid(10)
    claude_server(fpage, message(evil))
    open_claude(fpage); ask(fpage)
    assert fpage.input_value("#aiText") == evil
    assert fpage.evaluate("() => window.__pwned") is None
    assert fpage.evaluate("() => document.querySelectorAll('#aiResult img, #aiResult script, #aiNote img, #aiNote script, #claudeReview img').length") == 0


def test_a_question_can_be_cancelled_while_waiting(fpage, mock):
    scene(fpage, mock)
    held = []
    claude_server(fpage, hold=held)
    open_claude(fpage); review(fpage); fpage.click("#claudeSend")
    fpage.wait_for_function("() => document.getElementById('claudeAsk').textContent === 'Cancel'")
    assert "Asking Claude (claude-opus-5-5)" in note(fpage) and fpage.is_hidden("#claudeReview")
    fpage.click("#claudeAsk")
    fpage.wait_for_function("() => document.getElementById('claudeAsk').textContent === 'Ask Claude…'")
    assert "Stopped" in note(fpage) and "may already have received" in note(fpage) and fpage.input_value("#aiText") == ""


def test_switching_it_off_while_waiting_stops_the_question(fpage, mock):
    scene(fpage, mock)
    claude_server(fpage, hold=[])
    open_claude(fpage); review(fpage); fpage.click("#claudeSend")
    fpage.wait_for_function("() => document.getElementById('claudeAsk').textContent === 'Cancel'")
    fpage.uncheck("#claudeOn")
    fpage.wait_for_function("() => document.getElementById('aiNote').innerText.includes('Stopped')")
    assert fpage.input_value("#aiText") == ""


def test_the_local_model_and_claude_do_not_answer_at_the_same_time(fpage, mock):
    scene(fpage, mock)
    claude_server(fpage, hold=[])
    local = model_server(fpage, {"choices": [{"message": {"content": "x"}}]})
    open_claude(fpage); set_model(fpage)
    review(fpage); fpage.click("#claudeSend")
    fpage.wait_for_function("() => document.getElementById('claudeAsk').textContent === 'Cancel'")
    fpage.click("#aiAsk")
    assert "Claude is answering" in fpage.inner_text("#toast") and local == []


# ---- Test key ----------------------------------------------------------------------------------------------------------------------

def test_test_key_lists_the_models_and_sends_no_evidence(fpage, mock):
    scene(fpage, mock)
    server = claude_server(fpage, models=["claude-opus-5-5", "claude-sonnet-5-5"])
    open_claude(fpage); fpage.click("#claudeTest")
    fpage.wait_for_function("() => document.getElementById('aiNote').innerText.startsWith('The key works')")
    assert "Models: claude-opus-5-5, claude-sonnet-5-5." in note(fpage)
    assert [(s["method"], s["url"], s["body"]) for s in server] == [("GET", API + "/v1/models?limit=100", None)], "the key went, the evidence did not"
    assert server[0]["headers"]["x-api-key"] == KEY
    fpage.fill("#claudeModel", "claude-missing"); fpage.click("#claudeTest")
    fpage.wait_for_function("() => document.getElementById('aiNote').innerText.includes('is not among them')")


def test_test_key_says_when_the_key_is_not_accepted(fpage, mock):
    scene(fpage, mock)
    claude_server(fpage, api_error("authentication_error", "invalid x-api-key"), status=401)
    open_claude(fpage); fpage.click("#claudeTest")
    fpage.wait_for_function("() => document.getElementById('aiNote').innerText.includes('did not accept the key')")
    assert "bad" in (fpage.get_attribute("#aiNote", "class") or "")


# ---- the rule for a model on this computer is unchanged -------------------------------------------------------------------------

def test_the_local_model_address_still_cannot_point_at_anthropic(fpage, mock):
    scene(fpage, mock)
    server = claude_server(fpage, message("x"))
    set_model(fpage, endpoint="https://api.anthropic.com/v1")
    assert fpage.get_attribute("#aiEndpoint", "aria-invalid") == "true" and fpage.is_disabled("#aiAsk") and fpage.is_disabled("#aiTest")
    fpage.evaluate("() => document.getElementById('aiAsk').click()"); settle(fpage)
    assert server == []


def test_screenshot_of_the_panel_with_the_review_open(fpage, mock):
    """For the eyes: the amber marking in the heading, the panel, and the review. Saved with the other screenshots."""
    scene(fpage, mock)
    claude_server(fpage, message("x"))
    open_claude(fpage); review(fpage)
    fpage.set_viewport_size({"width": 1280, "height": 1100})
    shot(fpage, "claude_option_review.png")
    fpage.click("#claudeCancel")
    fpage.evaluate("() => document.querySelector('#aiSection > summary').scrollIntoView({ block: 'start' })")
    shot(fpage, "claude_option_marker.png")
