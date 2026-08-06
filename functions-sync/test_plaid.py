"""plaid_ingest unit tests — stdlib only, no network, mirroring test_simplefin's
style. The two sign conventions are the money paths here: get either wrong and
every figure in the app flips."""
import unittest

import plaid_ingest
import sync_core


class MapTxn(unittest.TestCase):
    def test_plaid_positive_amount_is_money_out(self):
        row = plaid_ingest.map_pl_txn(
            {"transaction_id": "t1", "amount": 12.34, "date": "2026-08-05",
             "name": "STARBUCKS #123", "merchant_name": "Starbucks"},
            "acct1", "chase")
        self.assertEqual(row["type"], "expense")
        self.assertEqual(row["amount"], 12.34)
        self.assertEqual(row["signed_cents"], -1234)
        self.assertEqual(row["fingerprint"], "acct1|-1234|2026-08-05")
        self.assertEqual(row["merchant"], "Starbucks")

    def test_plaid_negative_amount_is_money_in(self):
        row = plaid_ingest.map_pl_txn(
            {"transaction_id": "t2", "amount": -4382.05, "date": "2026-08-01",
             "name": "PAYROLL PPD"},
            "acct1", "chase")
        self.assertEqual(row["type"], "income")
        self.assertEqual(row["signed_cents"], 438205)

    def test_zero_or_dateless_rows_are_dropped(self):
        self.assertIsNone(plaid_ingest.map_pl_txn(
            {"transaction_id": "t3", "amount": 0, "date": "2026-08-01"}, "a", "p"))
        self.assertIsNone(plaid_ingest.map_pl_txn(
            {"transaction_id": "t4", "amount": 5}, "a", "p"))

    def test_pfc_becomes_source_category(self):
        row = plaid_ingest.map_pl_txn(
            {"transaction_id": "t5", "amount": 9.99, "date": "2026-08-05",
             "name": "X", "personal_finance_category": {"primary": "FOOD_AND_DRINK"}},
            "a", "p")
        self.assertEqual(row["sourceCategory"], "Food And Drink")
        # and it is in the writable field set
        self.assertIn("sourceCategory", plaid_ingest.PLAID_DOC_FIELDS)

    def test_raw_statement_text_survives_in_description(self):
        # personFrom() Zelle attribution reads description — the raw line must win
        row = plaid_ingest.map_pl_txn(
            {"transaction_id": "t6", "amount": 100, "date": "2026-08-05",
             "name": "Zelle payment to LOK", "original_description": "ZELLE TO LOK JULY",
             "merchant_name": "Zelle"},
            "a", "p")
        self.assertEqual(row["description"], "ZELLE TO LOK JULY")


class AdaptAccount(unittest.TestCase):
    def test_credit_balance_flips_to_liability_negative_convention(self):
        a = plaid_ingest.adapt_pl_account(
            {"account_id": "x", "name": "Blue Cash", "mask": "1005",
             "type": "credit", "balances": {"current": 2568.37}}, "Amex")
        self.assertEqual(a["currentBalance"], -2568.37)
        # ...so the SHARED opening rule lands on positive-owed, unchanged:
        self.assertEqual(sync_core.opening_balance_for("credit_card", a["currentBalance"]), 2568.37)

    def test_depository_balance_passes_through(self):
        a = plaid_ingest.adapt_pl_account(
            {"account_id": "y", "name": "Checking", "mask": "0292",
             "type": "depository", "balances": {"current": 790.19}}, "Chase")
        self.assertEqual(a["currentBalance"], 790.19)
        self.assertEqual(a["mask"], "0292")
        self.assertIn("Chase", a["displayName"])


class LinkToken(unittest.TestCase):
    def test_new_link_requests_730_days_of_transactions(self):
        body = plaid_ingest.link_token_payload("cid", "sec", "uid1")
        self.assertEqual(body["products"], ["transactions"])
        self.assertEqual(body["transactions"], {"days_requested": 730})
        self.assertNotIn("access_token", body)

    def test_update_mode_carries_the_token_and_no_products(self):
        # Trial plan: 10 lifetime Items — repair in place, never re-link.
        body = plaid_ingest.link_token_payload("cid", "sec", "uid1", access_token="tok")
        self.assertEqual(body["access_token"], "tok")
        self.assertNotIn("products", body)


class SyncWalk(unittest.TestCase):
    def test_cursor_walk_folds_modified_and_collects_removed(self):
        pages = [
            {"added": [{"transaction_id": "a"}], "modified": [{"transaction_id": "m"}],
             "removed": [{"transaction_id": "r"}], "next_cursor": "c1", "has_more": True},
            {"added": [{"transaction_id": "b"}], "modified": [],
             "removed": [], "next_cursor": "c2", "has_more": False},
        ]
        calls = []
        def post(path, body):
            calls.append(body.get("cursor"))
            return pages[len(calls) - 1]
        added, removed, cursor = plaid_ingest._sync_item_transactions(
            "cid", "sec", "tok", "", post)
        self.assertEqual([t["transaction_id"] for t in added], ["a", "m", "b"])
        self.assertEqual(removed, ["r"])
        self.assertEqual(cursor, "c2")
        self.assertEqual(calls, [None, "c1"])  # first call sends NO cursor key


if __name__ == "__main__":
    unittest.main()
