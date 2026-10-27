"""The built-in wallet list: what a computer can check stays true (valid addresses, one spelling of a name, no alternative that is the same name), and the review tool finds what it should."""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import review_known_addresses as rk  # noqa: E402


def test_every_address_in_the_list_passes_its_checksum_and_a_name_has_one_spelling():
    known = rk.load_known()
    found = rk.review(known, {})
    assert len(known) > 800
    assert found["bad_addresses"] == [], "an address that is not valid cannot be anybody's"
    assert found["case_variants"] == [], "one name, one spelling: " + str(found["case_variants"])
    assert found["same_name_alts"] == [], "an alternative name that is the same name written another way says nothing"
    assert not any("Houbi" in v["label"] for v in known.values()), "Huobi is spelled Huobi"


def test_the_review_tells_a_conflict_of_owners_from_a_difference_of_spelling():
    known = {
        "1BoatSLRHtKNngkdXEeobR76b53LETtpyT": {"label": "BitFlyer", "alt": ["Bitflyer"]},                      # the same name, written another way
        "1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF": {"label": "OKX", "alt": ["Binance"]},                              # another owner: a conflict
        "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq": {"label": "Binance Hot Wallet"},
        "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx": {"label": "BitFlyer"},                                    # a checksum that fails
    }
    found = rk.review(known, {})
    assert found["bad_addresses"] == ["bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx"]
    assert [x[0] for x in found["same_name_alts"]] == ["1BoatSLRHtKNngkdXEeobR76b53LETtpyT"]
    assert [x[0] for x in found["conflicts"]] == ["1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF"]
    assert found["case_variants"] == []
    again = rk.review({"1A": {"label": "Bitflyer"}, "1B": {"label": "BitFlyer"}}, {})
    assert again["case_variants"] == [["BitFlyer", "Bitflyer"]]


def test_an_address_in_a_pack_under_the_same_entity_is_the_same_and_under_another_is_different():
    known = {"1BoatSLRHtKNngkdXEeobR76b53LETtpyT": {"label": "Binance Hot Wallet"}, "1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF": {"label": "btc.top"}}
    pack = {"labels": [{"address": "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", "label": "binance reserve wallets BTC"}, {"address": "1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF", "label": "Mining pool: 1THash"}]}
    rows = rk.review(known, {"graphsense": pack})["pack_overlaps"]
    assert [(r[1][:6], r[4]) for r in rows] == [("1BoatS", True), ("1FeexV", False)]
