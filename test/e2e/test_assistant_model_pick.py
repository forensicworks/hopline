"""Assistant, the model drop-down: after Test connection the models the server listed are offered under the Model box, which stays a text box.
The model server is answered here (127.0.0.1:11434), so nothing leaves the machine."""
import json

import pytest

from chains import tid
from helpers import settle
from test_assistant import MODEL_URL, browser_noise, chat, model_server, set_model
from test_pattern_flags import scene


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def press_test(page, words="Connected"):
    page.click("#aiTest")
    page.wait_for_function("(w) => document.getElementById('aiNote').innerText.includes(w)", arg=words)


def options(page):
    return page.eval_on_selector_all("#aiModelPick option", "els => els.map(e => e.textContent)")


def test_nothing_is_asked_and_no_list_is_shown_until_the_test_is_clicked(fpage, mock):
    scene(fpage, mock)
    server = model_server(fpage, models=["llama3.1", "qwen2.5:7b"])
    set_model(fpage)
    settle(fpage)
    assert fpage.is_hidden("#aiModelPickBox") and server == []
    press_test(fpage)
    assert [(s["method"], s["url"]) for s in server] == [("GET", MODEL_URL + "/models")]


def test_after_a_successful_test_the_models_are_offered_and_the_one_in_the_box_is_shown_as_chosen(fpage, mock):
    scene(fpage, mock)
    model_server(fpage, models=["llama3.1", "qwen2.5:7b", "hf.co/user/model:Q4_K_M"])
    set_model(fpage, model="qwen2.5:7b"); press_test(fpage)
    assert fpage.is_visible("#aiModelPick") and fpage.text_content("label[for=aiModelPick]") == "Models on this server"
    assert options(fpage) == ["Pick one of the 3 models…", "llama3.1", "qwen2.5:7b", "hf.co/user/model:Q4_K_M"]
    assert fpage.input_value("#aiModelPick") == "qwen2.5:7b"
    assert "Models: llama3.1, qwen2.5:7b, hf.co/user/model:Q4_K_M." in fpage.inner_text("#aiNote")


def test_picking_one_fills_the_box_saves_it_and_is_the_model_that_is_asked(fpage, mock):
    scene(fpage, mock)
    server = model_server(fpage, chat("see " + tid(10)), models=["llama3.1", "qwen2.5:7b"])
    set_model(fpage, model="llama3.1"); press_test(fpage)
    fpage.select_option("#aiModelPick", "qwen2.5:7b")
    assert fpage.input_value("#aiModel") == "qwen2.5:7b"
    assert fpage.evaluate("() => window.__hopline.state.assist.model") == "qwen2.5:7b"
    assert "qwen2.5:7b" in fpage.evaluate("() => window.localStorage.getItem('hopline.prefs.v1')"), "saved with the other settings"
    fpage.click("#aiAsk"); fpage.wait_for_function("() => document.getElementById('aiText').value !== ''")
    assert json.loads(server[-1]["body"])["model"] == "qwen2.5:7b"
    fpage.select_option("#aiModelPick", "")
    assert fpage.input_value("#aiModel") == "qwen2.5:7b", "the first line of the list is not a model: choosing it changes nothing"


def test_typing_a_name_changes_what_the_list_shows_as_chosen(fpage, mock):
    scene(fpage, mock)
    model_server(fpage, models=["llama3.1", "qwen2.5:7b"])
    set_model(fpage, model="llama3.1"); press_test(fpage)
    assert fpage.input_value("#aiModelPick") == "llama3.1"
    fpage.fill("#aiModel", "my-own-32k")
    assert fpage.input_value("#aiModelPick") == "", "a name the list does not have: nothing is shown as chosen, and the name is kept as typed"
    assert fpage.evaluate("() => window.__hopline.state.assist.model") == "my-own-32k"
    fpage.fill("#aiModel", "qwen2.5:7b")
    assert fpage.input_value("#aiModelPick") == "qwen2.5:7b"


def test_an_empty_box_and_one_model_fills_it_in_but_two_models_do_not(fpage, mock):
    scene(fpage, mock)
    model_server(fpage, models=["only:latest"])
    set_model(fpage, model=""); press_test(fpage)
    assert fpage.input_value("#aiModel") == "only:latest" and fpage.evaluate("() => window.__hopline.state.assist.model") == "only:latest"
    assert "It is the only one, so it was filled in." in fpage.inner_text("#aiNote") and options(fpage) == ["Pick the model…", "only:latest"]
    model_server(fpage, models=["a:1", "b:2"])
    fpage.fill("#aiModel", ""); press_test(fpage, "Models: a:1, b:2")
    assert fpage.input_value("#aiModel") == "" and fpage.input_value("#aiModelPick") == "" and "filled in" not in fpage.inner_text("#aiNote")


def test_a_model_the_server_does_not_have_is_flagged_and_the_list_is_there_to_fix_it(fpage, mock):
    scene(fpage, mock)
    model_server(fpage, models=["llama3.1", "qwen2.5:7b"])
    set_model(fpage, model="missing"); press_test(fpage, "is not among them")
    assert fpage.input_value("#aiModelPick") == "" and options(fpage)[1:] == ["llama3.1", "qwen2.5:7b"]
    fpage.select_option("#aiModelPick", "llama3.1")
    assert fpage.input_value("#aiModel") == "llama3.1"


def test_a_failed_or_empty_test_and_a_changed_address_take_the_list_away(fpage, mock, errors):
    scene(fpage, mock)
    model_server(fpage, models=["llama3.1", "qwen2.5:7b"])
    set_model(fpage); press_test(fpage)
    assert fpage.is_visible("#aiModelPickBox")
    model_server(fpage, "down"); fpage.click("#aiTest")
    fpage.wait_for_function("() => document.getElementById('aiNote').innerText.includes('Could not reach the model')")
    assert fpage.is_hidden("#aiModelPickBox"); browser_noise(errors)
    model_server(fpage, models=["llama3.1"]); press_test(fpage)
    assert fpage.is_visible("#aiModelPickBox")
    fpage.fill("#aiEndpoint", "http://localhost:1234/v1")
    assert fpage.is_hidden("#aiModelPickBox"), "the list belongs to the server it came from"
    fpage.fill("#aiEndpoint", MODEL_URL)
    model_server(fpage, models=[]); press_test(fpage, "lists no models")
    assert fpage.is_hidden("#aiModelPickBox")


def test_a_name_that_could_not_be_sent_as_it_is_is_not_offered(fpage, mock):
    scene(fpage, mock)
    model_server(fpage, models=["good:1", "bad name!"])
    set_model(fpage, model=""); press_test(fpage)
    assert options(fpage) == ["Pick the model…", "good:1"]
    assert fpage.input_value("#aiModel") == "good:1", "the one that can be used is the only one, so it is filled in"
