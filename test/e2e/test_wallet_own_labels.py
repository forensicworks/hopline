"""The wallet page uses the labels, tags and notes you wrote in the workspace (the saved session), next to the built-in list and your label lists."""
import json

import pytest

from conftest import ADDRESS
from test_wallet_page import KNOWN_BUILTIN, PAYER, WALLET_URL, goto, wpage  # noqa: F401  (the fixture is used by name)


@pytest.fixture(autouse=True)
def no_js_errors(errors):
    yield
    assert not errors, "browser reported errors: %s" % errors


def session(ctx, nodes, fmt="hopline-workspace", key="hopline.workspace.v1"):
    text = json.dumps({"format": fmt, "version": 1, "nodes": nodes, "edges": []})
    ctx.add_init_script("localStorage.setItem(%s, %s);" % (json.dumps(key), json.dumps(text)))


def node(address, **kw):
    n = {"id": "addr:" + address, "type": "addr", "address": address}
    n.update(kw)
    return n


def test_a_label_and_a_tag_you_wrote_name_the_wallet_at_the_top(ctx, wpage):
    session(ctx, [node(ADDRESS, label="My cold wallet", tag="EXCH", note="kept in the safe")])
    goto(wpage)
    assert wpage.inner_text("#addrLabel") == "My cold wallet" and wpage.inner_text("#addrTag") == "EXCH"
    assert wpage.inner_text("#addrNote") == "kept in the safe"
    assert "Your labels" in wpage.get_attribute("#addrLabel", "title")


def test_the_wallets_it_dealt_with_are_named_in_the_associations_and_on_the_cards(ctx, wpage):
    session(ctx, [node(PAYER, label="Suspect A", tag="THREAT")])
    goto(wpage)
    row = wpage.locator("#assoc .assocrow").filter(has_text="Suspect A")
    assert row.count() == 1 and "THREAT" in row.inner_text() and "Your labels" in row.inner_text()
    assert wpage.locator("#ledger .tx .lbl:has-text('Suspect A')").count() >= 1
    assert "labels and tags you wrote in the workspace" in wpage.inner_text("#assocSec")


def test_a_tag_alone_is_a_name(ctx, wpage):
    session(ctx, [node(PAYER, tag="MIXER")])
    goto(wpage)
    assert wpage.locator("#assoc .assocrow").filter(has_text="MIXER").count() == 1


def test_your_name_comes_first_and_the_built_in_name_is_listed_as_another_claim(ctx, wpage):
    session(ctx, [node(KNOWN_BUILTIN, label="My name for Robinhood")])
    goto(wpage)
    row = wpage.locator("#assoc .assocrow").filter(has_text="My name for Robinhood")
    assert row.count() == 1 and "Robinhood Hot Wallet" not in row.inner_text()
    assert wpage.evaluate("(a) => window.__wallet.known(a).claims.map((c) => c.label)", KNOWN_BUILTIN) == ["My name for Robinhood", "Robinhood Hot Wallet"]


def test_on_the_wallet_itself_two_claims_are_listed(ctx, wpage):
    session(ctx, [node(ADDRESS, label="Mine")])
    ctx.add_init_script("localStorage.setItem('hopline.packs.v1', %s);" % json.dumps(json.dumps([{"id": "p1", "name": "Case list", "enabled": True, "entries": [[ADDRESS, "Their name"]]}])))
    goto(wpage)
    assert wpage.inner_text("#addrLabel") == "Mine"
    assert "listed by 2 sources" in wpage.inner_text("#claims").lower()
    rows = wpage.locator("#claims .claimrow")
    assert rows.count() == 2 and "Your labels" in rows.nth(0).inner_text() and "Case list" in rows.nth(1).inner_text()


def test_a_session_from_before_the_rename_is_read_too(ctx, wpage):
    session(ctx, [node(ADDRESS, label="From the old days")], fmt="orion-workspace", key="orion.workspace.v1")
    goto(wpage)
    assert wpage.inner_text("#addrLabel") == "From the old days"


def test_nothing_is_listed_for_wallets_you_did_not_write_on_and_a_wallet_without_a_session_is_as_before(ctx, wpage):
    session(ctx, [node(ADDRESS), node(PAYER)])
    goto(wpage)
    assert wpage.is_hidden("#addrLabel") and wpage.is_hidden("#addrTag")


def test_a_damaged_or_foreign_session_is_ignored_quietly(ctx, wpage):
    ctx.add_init_script("localStorage.setItem('hopline.workspace.v1', '{not json at all');")
    goto(wpage)
    assert wpage.is_hidden("#addrLabel") and cards_present(wpage)


def cards_present(page):
    return page.locator("#ledger .tx").count() > 0


def test_hostile_text_you_or_a_file_put_in_a_label_stays_text(ctx, wpage):
    session(ctx, [node(ADDRESS, label="<img src=x onerror=window.__pwned=1>", tag="<b>x</b>", note="<script>window.__pwned=2</script>")])
    goto(wpage)
    assert wpage.evaluate("() => window.__pwned") is None
    assert wpage.locator("#head img, #head script, #head b").count() == 0
    assert "<img src=x" in wpage.inner_text("#addrLabel") and "<script>" in wpage.inner_text("#addrNote")


def test_a_label_on_a_transaction_or_a_bad_address_does_nothing(ctx, wpage):
    session(ctx, [{"id": "tx:" + "ab" * 32, "type": "tx", "txid": "ab" * 32, "label": "a tx label"}, node("not-an-address", label="x")])
    goto(wpage)
    assert wpage.is_hidden("#addrLabel") and "a tx label" not in wpage.inner_text("body")
