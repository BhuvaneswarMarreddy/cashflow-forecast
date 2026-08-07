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


class Transfers(unittest.TestCase):
    """Movement is not spending. A card payment counted as an expense is charged
    twice — once as the payment, once as the purchases it settled."""

    def pfc(self, primary, detailed=""):
        return {"transaction_id": "t", "amount": 500.0, "date": "2026-08-05", "name": "X",
                "personal_finance_category": {"primary": primary, "detailed": detailed}}

    def test_transfer_out_becomes_a_transfer_not_an_expense(self):
        row = plaid_ingest.map_pl_txn(self.pfc("TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER"), "a", "chase")
        self.assertEqual(row["type"], "transfer")
        self.assertEqual(row["transferDirection"], "out")

    def test_transfer_in_carries_direction_in(self):
        t = self.pfc("TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER")
        t["amount"] = -500.0  # Plaid negative = money arriving
        row = plaid_ingest.map_pl_txn(t, "a", "chase")
        self.assertEqual(row["type"], "transfer")
        self.assertEqual(row["transferDirection"], "in")

    def test_credit_card_payment_is_a_transfer_via_the_detailed_value(self):
        row = plaid_ingest.map_pl_txn(
            self.pfc("LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"), "a", "chase")
        self.assertEqual(row["type"], "transfer")

    def test_other_loan_payments_stay_a_real_cost(self):
        # a car or student loan payment IS money leaving for good
        row = plaid_ingest.map_pl_txn(
            self.pfc("LOAN_PAYMENTS", "LOAN_PAYMENTS_CAR_PAYMENT"), "a", "chase")
        self.assertEqual(row["type"], "expense")
        self.assertIsNone(row["transferDirection"])

    def test_ordinary_spending_is_untouched(self):
        row = plaid_ingest.map_pl_txn(self.pfc("FOOD_AND_DRINK"), "a", "chase")
        self.assertEqual(row["type"], "expense")
        self.assertIsNone(row["transferDirection"])

    def test_missing_category_never_guesses_transfer(self):
        row = plaid_ingest.map_pl_txn(
            {"transaction_id": "t", "amount": 10, "date": "2026-08-05", "name": "X"}, "a", "p")
        self.assertEqual(row["type"], "expense")

    def test_a_payroll_deposit_plaid_filed_as_TRANSFER_IN_stays_income(self):
        # Plaid files some direct deposits as TRANSFER_IN. Typing those as
        # transfers cost the owner 18 of 36 paychecks and hid them from the
        # unknown-inflow review queue.
        t = self.pfc("TRANSFER_IN", "TRANSFER_IN_DEPOSIT")
        t["amount"] = -4351.25
        row = plaid_ingest.map_pl_txn(t, "a", "chase")
        self.assertEqual(row["type"], "income")
        self.assertIsNone(row["transferDirection"])

    def test_zelle_to_a_person_is_real_money_leaving_not_a_transfer(self):
        row = plaid_ingest.map_pl_txn(
            self.pfc("TRANSFER_OUT", "TRANSFER_OUT_OTHER_TRANSFER_OUT"), "a", "chase")
        self.assertEqual(row["type"], "expense")

    def test_atm_cash_is_spending_not_a_transfer(self):
        row = plaid_ingest.map_pl_txn(
            self.pfc("TRANSFER_OUT", "TRANSFER_OUT_WITHDRAWAL"), "a", "chase")
        self.assertEqual(row["type"], "expense")

    def test_moving_money_to_your_own_savings_is_a_transfer(self):
        row = plaid_ingest.map_pl_txn(
            self.pfc("TRANSFER_OUT", "TRANSFER_OUT_SAVINGS"), "a", "chase")
        self.assertEqual(row["type"], "transfer")

    def test_transferDirection_is_writable_to_the_doc(self):
        self.assertIn("transferDirection", plaid_ingest.PLAID_DOC_FIELDS)


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


class AutoCreateAccounts(unittest.TestCase):
    """A Plaid account is a CONSENT record — the owner authorised it in Link — so
    an unmatched one is created, not skipped. The anchor is what keeps 730 days
    of imported history from being added on top of a balance that contains it."""

    def test_credit_card_account_is_created_with_positive_owed_and_tomorrow_anchor(self):
        raw = {"account_id": "p1", "name": "Blue Cash Preferred", "mask": "1005",
               "type": "credit", "balances": {"current": 2568.37}}
        adapted = plaid_ingest.adapt_pl_account(raw, "American Express")
        # adapt_pl_account stamps displayLastUpdatedAt with the REAL clock (a live
        # balance pull's date is now — intentional), and anchor_when prefers that
        # stamp over `today`. Left unpinned, this test only passes while the wall
        # clock reads 2026-08-06 (issue #19: green at 23:15, red at 00:21). Pin it.
        adapted["displayLastUpdatedAt"] = "2026-08-06T12:00:00-05:00"
        fields = plaid_ingest.new_account_fields(adapted, raw, "American Express", "2026-08-06")
        self.assertEqual(fields["type"], "credit_card")
        self.assertEqual(fields["provider"], "amex")
        self.assertEqual(fields["lastFourDigits"], "1005")
        self.assertEqual(fields["openingBalance"], 2568.37)   # app stores debt positive
        self.assertEqual(fields["openingDate"], "2026-08-07")  # day after the balance
        self.assertTrue(fields["isActive"])

    def test_checking_account_keeps_balance_sign_and_gets_bank_provider(self):
        raw = {"account_id": "p2", "name": "TOTAL CHECKING", "mask": "0292",
               "type": "depository", "subtype": "checking",
               "balances": {"current": 790.19}}
        adapted = plaid_ingest.adapt_pl_account(raw, "Chase")
        fields = plaid_ingest.new_account_fields(adapted, raw, "Chase", "2026-08-06")
        self.assertEqual(fields["type"], "bank_account")
        self.assertEqual(fields["provider"], "chase")
        self.assertEqual(fields["openingBalance"], 790.19)

    def test_unknown_issuer_falls_back_rather_than_inventing_a_brand(self):
        self.assertEqual(plaid_ingest.provider_for("Synchrony Bank", "credit_card")[0], "other")
        self.assertEqual(plaid_ingest.provider_for("Bank of America", "bank_account")[0], "bank-transfer")

    def test_institution_name_is_not_repeated_in_the_account_name(self):
        raw = {"account_id": "p3", "name": "Chase Sapphire", "type": "credit",
               "balances": {"current": 10.0}}
        adapted = plaid_ingest.adapt_pl_account(raw, "Chase")
        self.assertEqual(
            plaid_ingest.new_account_fields(adapted, raw, "Chase", "2026-08-06")["name"],
            "Chase Sapphire")


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
