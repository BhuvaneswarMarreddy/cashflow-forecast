"""Pure-logic tests for the SimpleFIN sync — no network, no Firestore, no cloud deps.

Run:  python3 -m pytest functions-sync/test_simplefin.py
 or:  python3 -m unittest discover -s functions-sync
"""
import base64
import datetime as dt
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import simplefin as sf  # noqa: E402
import sync_core as sc  # noqa: E402


class SetupTokenClaim(unittest.TestCase):
    CLAIM = "https://bridge.simplefin.org/simplefin/claim/DEMO"
    ACCESS = "https://user123:pass456@bridge.simplefin.org/simplefin"

    def test_decodes_and_posts_once(self):
        seen = []

        def poster(url):
            seen.append(url)
            return self.ACCESS + "\n"

        token = base64.b64encode(self.CLAIM.encode()).decode()
        self.assertEqual(sf.claim_setup_token(token, post=poster), self.ACCESS)
        self.assertEqual(seen, [self.CLAIM], "the setup token is single use — POST once")

    def test_accepts_unpadded_token(self):
        # Bridges hand out the token without '=' padding often enough to matter.
        token = base64.b64encode(self.CLAIM.encode()).decode().rstrip("=")
        self.assertEqual(sf.claim_setup_token(token, post=lambda u: self.ACCESS), self.ACCESS)

    def test_rejects_junk_token_and_junk_response(self):
        with self.assertRaises(ValueError):
            sf.claim_setup_token("", post=lambda u: self.ACCESS)
        with self.assertRaises(ValueError):  # decodes to something that is not a URL
            sf.claim_setup_token(base64.b64encode(b"nope").decode(), post=lambda u: self.ACCESS)
        with self.assertRaises(RuntimeError):  # bridge replied with an error page
            sf.claim_setup_token(base64.b64encode(self.CLAIM.encode()).decode(),
                                 post=lambda u: "Forbidden")

    def test_credentials_move_from_url_into_basic_header(self):
        # urllib silently ignores userinfo in a URL, so every request would 401.
        base, auth = sf.split_auth(self.ACCESS)
        self.assertEqual(base, "https://bridge.simplefin.org/simplefin")
        self.assertEqual(auth, "Basic " + base64.b64encode(b"user123:pass456").decode())


class FetchAccounts(unittest.TestCase):
    ACCESS = "https://u:p@bridge.simplefin.org/simplefin"

    def test_sends_the_window_and_returns_the_payload(self):
        seen = {}

        def getter(url, auth=None, timeout=60):
            seen["url"], seen["auth"] = url, auth
            return '{"errors": [], "accounts": [{"id": "a"}]}'

        data = sf.fetch_accounts(self.ACCESS, 1000, 2000, get=getter)
        self.assertEqual(data["accounts"][0]["id"], "a")
        self.assertEqual(
            seen["url"],
            "https://bridge.simplefin.org/simplefin/accounts?start-date=1000&end-date=2000")
        self.assertTrue(seen["auth"].startswith("Basic "))

    def test_non_empty_errors_raises(self):
        with self.assertRaises(RuntimeError) as ctx:
            sf.fetch_accounts(self.ACCESS, 1, 2,
                              get=lambda u, a=None, timeout=60:
                              '{"errors": ["Chase needs attention"], "accounts": []}')
        self.assertIn("Chase needs attention", str(ctx.exception))


def mk(amount="-23.54", posted=1753416000, payee="Instacart",
       description="IC INSTACART 8009971277", **over):
    t = {"id": "sf-1", "amount": amount, "posted": posted, "payee": payee,
         "description": description, "pending": False}
    t.update(over)
    return t


class TxnMapping(unittest.TestCase):
    def test_expense(self):
        r = sf.map_sf_txn(mk(), "acct1", "chase")
        self.assertEqual(r["type"], "expense")
        self.assertEqual(r["amount"], 23.54)
        self.assertEqual(r["signed_cents"], -2354)
        self.assertEqual(r["title"], "Instacart")               # payee first
        self.assertEqual(r["merchant"], "Instacart")
        self.assertEqual(r["description"], "IC INSTACART 8009971277")  # raw statement
        self.assertEqual(r["accountId"], "acct1")
        self.assertEqual(r["paymentMethod"], "chase")

    def test_income(self):
        r = sf.map_sf_txn(mk(amount="4309.93", payee="The Canton Co"), "acct1", "chase")
        self.assertEqual((r["type"], r["amount"], r["signed_cents"]),
                         ("income", 4309.93, 430993))

    def test_no_source_category_is_written(self):
        # SimpleFIN has no categories. The field must stay ABSENT so a later Monarch
        # CSV can fill it in — writing '' or 'other' would look like real data.
        r = sf.map_sf_txn(mk(), "acct1", "chase")
        self.assertNotIn("sourceCategory", r)
        self.assertNotIn("sourceCategory", sf.DOC_FIELDS)

    def test_title_falls_back_to_statement_then_placeholder(self):
        self.assertEqual(sf.map_sf_txn(mk(payee=""), "a", "chase")["title"],
                         "IC INSTACART 8009971277")
        self.assertIsNone(sf.map_sf_txn(mk(payee=""), "a", "chase")["merchant"])
        self.assertEqual(sf.map_sf_txn(mk(payee="", description=""), "a", "chase")["title"],
                         "Transaction")

    def test_pending_and_zero_and_undated_are_dropped(self):
        self.assertIsNone(sf.map_sf_txn(mk(pending=True), "a", "chase"))
        self.assertIsNone(sf.map_sf_txn(mk(amount="0.00"), "a", "chase"))
        self.assertIsNone(sf.map_sf_txn(mk(amount="-0.00"), "a", "chase"))
        self.assertIsNone(sf.map_sf_txn(mk(posted=None), "a", "chase"))

    def test_date_is_chicago_midnight_of_the_posted_day(self):
        # 2026-07-25 03:00 UTC is still 2026-07-24 in Chicago — the calendar day the
        # owner sees, and the one every other importer wrote.
        r = sf.map_sf_txn(mk(posted=int(dt.datetime(2026, 7, 25, 3, 0,
                                                    tzinfo=dt.timezone.utc).timestamp())),
                          "a", "chase")
        self.assertEqual(r["date_key"], "2026-07-24")
        self.assertEqual(r["date"], dt.datetime(2026, 7, 24, tzinfo=sc.TZ))


class DecimalStringAmounts(unittest.TestCase):
    """SimpleFIN sends decimal STRINGS. float('-12.34') * 100 is -1233.9999999999998,
    so a float path silently drifts a cent on ordinary values."""

    def test_exact_cents(self):
        for text, cents in [("-12.34", -1234), ("12.34", 1234), ("0.07", 7),
                            ("-0.01", -1), ("1.005", 101), ("-1.005", -101),
                            ("4309.93", 430993), ("-2068.93", -206893),
                            ("100", 10000), ("-8.29", -829)]:
            self.assertEqual(sf.to_cents(text), cents, text)

    def test_no_drift_over_a_statement(self):
        rows = ["-12.34", "-8.29", "-0.07", "-119.99", "-1.11", "-23.54", "-4.20"]
        self.assertEqual(sum(sf.to_cents(r) for r in rows), -16954)


class Fingerprint(unittest.TestCase):
    """Byte-match with fingerprintOf() in src/lib/fingerprint.ts, including the
    `accountId ?? 'none'` fallback — the two ingest paths join on this string."""

    def test_format_and_sign(self):
        self.assertEqual(sf.fingerprint("acct1", -2354, "2026-07-24"),
                         "acct1|-2354|2026-07-24")
        self.assertEqual(sf.fingerprint("acct1", 430993, "2026-07-24"),
                         "acct1|430993|2026-07-24")
        self.assertEqual(sf.fingerprint("", -1, "2026-07-24"), "none|-1|2026-07-24")

    def test_matches_a_mapped_row(self):
        r = sf.map_sf_txn(mk(), "acct1", "chase")
        self.assertEqual(r["fingerprint"], f"acct1|-2354|{r['date_key']}")

    def test_existing_row_signs_match_the_ts_rules(self):
        cents = sf.signed_cents_of
        self.assertEqual(cents({"amount": 23.54, "type": "expense"}), -2354)
        self.assertEqual(cents({"amount": 23.54, "type": "income"}), 2354)
        self.assertEqual(cents({"amount": 700, "type": "transfer",
                                "transferDirection": "in"}), 70000)
        self.assertEqual(cents({"amount": 700, "type": "transfer",
                                "transferDirection": "out"}), -70000)
        # A directionless transfer counts as money LEAVING (isPositive in classify.ts).
        self.assertEqual(cents({"amount": 700, "type": "transfer"}), -70000)

    def test_a_refund_never_matches_the_charge_it_reverses(self):
        charge = sf.signed_cents_of({"amount": 50, "type": "expense"})
        refund = sf.signed_cents_of({"amount": 50, "type": "income"})
        self.assertNotEqual(charge, refund)


class FetchWindow(unittest.TestCase):
    TODAY = dt.date(2026, 8, 2)

    def _days(self, last_sync):
        start_ts, end_ts = sf.fetch_window(last_sync, self.TODAY)
        to_date = (lambda ts: dt.datetime.fromtimestamp(ts, sc.TZ).date())
        return to_date(start_ts), to_date(end_ts)

    def test_first_run_reaches_the_full_90_day_history(self):
        start, end = self._days(None)
        self.assertEqual(start, self.TODAY - dt.timedelta(days=90))
        self.assertEqual(end, self.TODAY + dt.timedelta(days=1),
                         "end must be TOMORROW or today's rows fall outside the window")

    def test_overlap_reaches_back_for_late_posting_rows(self):
        start, _ = self._days("2026-08-01")
        self.assertEqual(start, dt.date(2026, 8, 1) - dt.timedelta(days=sc.OVERLAP_DAYS))
        self.assertGreaterEqual(sc.OVERLAP_DAYS, 30)

    def test_overlap_is_clamped_to_the_90_day_server_limit(self):
        # An old cursor (or a long outage) must not ask for history the bridge
        # refuses to serve.
        start, _ = self._days("2026-01-01")
        self.assertEqual(start, self.TODAY - dt.timedelta(days=90))

    def test_bounds_are_local_midnight_unix_seconds(self):
        start_ts, _ = sf.fetch_window("2026-08-01", self.TODAY)
        self.assertIsInstance(start_ts, int)
        self.assertEqual(dt.datetime.fromtimestamp(start_ts, sc.TZ).hour, 0)


def cand(doc_id, date_key, sources=(), **doc):
    return {"id": doc_id, "date_key": date_key, "sources": set(sources), "doc": doc}


class TwinMatching(unittest.TestCase):
    def test_matches_within_three_days_and_not_beyond(self):
        self.assertEqual(sf.pick_match([cand("a", "2026-07-27")], "2026-07-24")["id"], "a")
        self.assertIsNone(sf.pick_match([cand("a", "2026-07-28")], "2026-07-24"))

    def test_nearest_date_wins_ties_go_to_the_earlier_row(self):
        far, near = cand("far", "2026-07-27"), cand("near", "2026-07-25")
        self.assertEqual(sf.pick_match([far, near], "2026-07-24")["id"], "near")
        # Equidistant: deterministic regardless of Firestore's return order.
        before, after = cand("before", "2026-07-23"), cand("after", "2026-07-25")
        self.assertEqual(sf.pick_match([after, before], "2026-07-24")["id"], "before")
        self.assertEqual(sf.pick_match([before, after], "2026-07-24")["id"], "before")

    def test_never_re_matches_a_row_this_source_already_wrote(self):
        self.assertIsNone(sf.pick_match([cand("a", "2026-07-24", ["simplefin"])],
                                        "2026-07-24"))

    def test_two_identical_charges_never_collapse_onto_one_row(self):
        # The spec's named risk: two $5.00 coffees on one day. Matching is
        # one-to-one, so the second must find nothing and insert.
        bucket = [cand("csv1", "2026-07-24")]
        first = sf.pick_match(bucket, "2026-07-24")
        bucket.remove(first)
        self.assertIsNone(sf.pick_match(bucket, "2026-07-24"),
                          "a wrongly merged pair silently understates spending")


class MergeRules(unittest.TestCase):
    ROW = {"title": "AMZN Mktp", "merchant": "AMZN Mktp", "category": "shopping",
           "description": "AMZN MKTP US*2H4KJ", "fingerprint": "a|-1234|2026-07-24"}

    def test_only_fills_blanks_never_overwrites_monarchs_cleaner_values(self):
        existing = {"title": "Amazon", "merchant": "Amazon", "category": "shopping",
                    "description": "AMZN MKTP US*2H4KJ", "fingerprint": "a|-1234|2026-07-24"}
        self.assertEqual(sf.merge_fields(existing, self.ROW), {})

    def test_fills_a_missing_merchant_description_and_fingerprint(self):
        patch = sf.merge_fields({"title": "Amazon", "category": "shopping"}, self.ROW)
        self.assertEqual(patch, {"merchant": "AMZN Mktp",
                                 "description": "AMZN MKTP US*2H4KJ",
                                 "fingerprint": "a|-1234|2026-07-24"})

    def test_hand_edited_fields_are_sacred(self):
        patch = sf.merge_fields({"userEdited": {"merchant": True, "description": True}},
                                self.ROW)
        self.assertNotIn("merchant", patch)
        self.assertNotIn("description", patch)


class AccountAdapter(unittest.TestCase):
    APP = [{"id": "1", "name": "Adv SafeBalance Banking", "lastFourDigits": "2126",
            "type": "bank_account"},
           {"id": "2", "name": "Customized Cash Rewards", "lastFourDigits": "3572",
            "type": "credit_card"}]

    def test_org_and_last_four_reach_the_shared_matcher(self):
        accounts = [
            {"id": "sf-a", "name": "Adv SafeBalance Banking ...2126", "balance": "829.60",
             "org": {"name": "Bank of America"}},
            {"id": "sf-b", "name": "Customized Cash Rewards Visa", "balance": "-507.96",
             "org": {"name": "Bank of America"}},
        ]
        matched, unmatched, ambiguous = sc.resolve_matches(
            [sf.adapt_account(a) for a in accounts], self.APP)
        self.assertEqual(ambiguous, [])
        self.assertEqual(matched["sf-a"][1]["id"], "1")   # last-4 in the name
        self.assertEqual(matched["sf-b"][1]["id"], "2")   # name-contains
        self.assertEqual(unmatched, [])

    def test_ambiguity_is_refused_not_guessed(self):
        accounts = [{"id": "x", "name": "Checking ...2126", "org": {"name": "BoA"}},
                    {"id": "y", "name": "Old Checking ...2126", "org": {"name": "BoA"}}]
        matched, _, ambiguous = sc.resolve_matches(
            [sf.adapt_account(a) for a in accounts], self.APP)
        self.assertEqual(matched, {})
        self.assertEqual(len(ambiguous), 1)

    def test_stale_balance_date_is_not_trusted(self):
        now = dt.datetime(2026, 8, 2, 12, tzinfo=dt.timezone.utc)
        fresh = sf.adapt_account({"id": "a", "name": "x", "balance": "1",
                                  "balance-date": int(now.timestamp()) - 3600})
        stale = sf.adapt_account({"id": "a", "name": "x", "balance": "1",
                                  "balance-date": int(now.timestamp()) - 5 * 86400})
        self.assertTrue(sc.balance_is_trustworthy(fresh, now)[0])
        self.assertFalse(sc.balance_is_trustworthy(stale, now)[0],
                         "a broken feed reporting 0.00 must never overwrite the anchor")

    def test_debt_balance_keeps_the_apps_positive_owed_convention(self):
        self.assertEqual(sc.opening_balance_for("credit_card",
                                                float(sf.adapt_account(
                                                    {"id": "a", "balance": "-507.96"}
                                                )["currentBalance"])), 507.96)


if __name__ == "__main__":
    unittest.main()
