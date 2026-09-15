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


class BankDatedBalance(unittest.TestCase):
    """#183 / invariant 8: a balance is dated by the bank, not by our sync clock."""

    def test_last_updated_datetime_dates_the_anchor(self):
        raw = {"account_id": "b1", "name": "Schwab Checking", "type": "depository",
               "balances": {"current": 5000.0, "last_updated_datetime": "2026-09-10T15:00:00Z"}}
        adapted = plaid_ingest.adapt_pl_account(raw, "Charles Schwab")
        self.assertEqual(adapted["displayLastUpdatedAt"], "2026-09-10T15:00:00Z")
        # the day after the bank's own stamp — not tomorrow relative to the sync
        self.assertEqual(sync_core.anchor_when(adapted, "2026-09-15"), "2026-09-11")
        fields = plaid_ingest.new_account_fields(adapted, raw, "Charles Schwab", "2026-09-15")
        self.assertEqual(fields["openingDate"], "2026-09-11")

    def test_absent_stamp_means_a_live_balance_dated_now(self):
        raw = {"account_id": "b2", "name": "Checking", "type": "depository",
               "balances": {"current": 10.0, "last_updated_datetime": None}}
        stamp = plaid_ingest.adapt_pl_account(raw, "Chase")["displayLastUpdatedAt"]
        self.assertTrue(stamp.startswith(sync_core.now_iso()[:10]))


class OneItemPerInstitution(unittest.TestCase):
    """#183: a second Link for a connected bank is refused before any token exists."""

    ITEMS = {
        "item-schwab": {"accessToken": "tok-1", "institution": "Charles Schwab",
                        "institutionId": "ins_11"},
        "item-legacy": {"accessToken": "tok-2", "institution": "Chase"},  # linked before ids
    }

    def test_same_institution_id_is_the_existing_item(self):
        self.assertEqual(plaid_ingest.existing_item_for(self.ITEMS, "ins_11", "Schwab (renamed)"), "item-schwab")

    def test_legacy_item_without_an_id_matches_by_name(self):
        self.assertEqual(plaid_ingest.existing_item_for(self.ITEMS, "ins_56", "chase"), "item-legacy")

    def test_an_item_with_an_id_is_never_matched_by_name_alone(self):
        # Two different institutions can share a display name; the id is the truth.
        self.assertIsNone(plaid_ingest.existing_item_for(self.ITEMS, "ins_99", "Charles Schwab"))

    def test_a_new_institution_is_not_matched(self):
        self.assertIsNone(plaid_ingest.existing_item_for(self.ITEMS, "ins_3", "Bank of America"))

    def test_second_exchange_is_refused_and_no_token_is_exchanged(self):
        calls = []
        outcome = plaid_ingest.exchange_new_item(
            "cid", "sec", self.ITEMS, "public-sandbox-x", "Charles Schwab", "ins_11",
            post=lambda path, body: calls.append(path) or {})
        self.assertEqual(outcome, ("exists", "item-schwab"))
        self.assertEqual(calls, [])

    def test_first_exchange_stores_the_institution_id_on_the_item(self):
        calls = []

        def post(path, body):
            calls.append(path)
            return {"access_token": "access-new", "item_id": "item-boa"}

        status, item_id, entry = plaid_ingest.exchange_new_item(
            "cid", "sec", self.ITEMS, "public-sandbox-y", "Bank of America", "ins_3", post=post)
        self.assertEqual((status, item_id), ("linked", "item-boa"))
        self.assertEqual(calls, ["/item/public_token/exchange"])
        self.assertEqual(entry["institutionId"], "ins_3")
        self.assertEqual(entry["institution"], "Bank of America")
        self.assertEqual(entry["cursor"], "")

    def test_the_client_list_never_carries_a_token(self):
        listed = plaid_ingest.linked_institutions(self.ITEMS)
        self.assertEqual({x["itemId"] for x in listed}, {"item-schwab", "item-legacy"})
        self.assertNotIn("tok-1", repr(listed))
        self.assertNotIn("accessToken", repr(listed))


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
        # #183: Repair is how the owner ticks more accounts (Schwab starts them unchecked).
        self.assertEqual(body["update"], {"account_selection_enabled": True})

    def test_new_link_does_not_send_update_options(self):
        self.assertNotIn("update", plaid_ingest.link_token_payload("cid", "sec", "uid1"))


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

    def test_brokerage_is_an_investment_account_never_a_bank_account(self):
        # #182: as bank_account, calculateCurrentCash summed the whole portfolio into
        # cash and runway. Both Plaid spellings land on the net-worth-only type.
        for plaid_type in ("investment", "brokerage"):
            raw = {"account_id": "s1", "name": "Schwab One Brokerage", "mask": "4321",
                   "type": plaid_type, "subtype": "brokerage", "balances": {"current": 80000.0}}
            adapted = plaid_ingest.adapt_pl_account(raw, "Charles Schwab")
            adapted["displayLastUpdatedAt"] = "2026-09-15T12:00:00-05:00"
            fields = plaid_ingest.new_account_fields(adapted, raw, "Charles Schwab", "2026-09-15")
            self.assertEqual(fields["type"], "investment")
            self.assertEqual(fields["openingBalance"], 80000.0)   # an asset: sign kept
            self.assertEqual(fields["openingDate"], "2026-09-16")

    def test_brokerage_without_a_balance_stays_unanchored_not_zero(self):
        # #182: no $0 stand-in. openingDate None -> isUnanchored -> "Not anchored".
        raw = {"account_id": "s2", "name": "Schwab Brokerage", "type": "investment",
               "balances": {"current": None}}
        adapted = plaid_ingest.adapt_pl_account(raw, "Charles Schwab")
        fields = plaid_ingest.new_account_fields(adapted, raw, "Charles Schwab", "2026-09-15")
        self.assertEqual(fields["type"], "investment")
        self.assertIsNone(fields["openingDate"])

    def test_schwab_checking_is_still_operating_cash(self):
        raw = {"account_id": "s3", "name": "Schwab Checking", "type": "depository",
               "subtype": "checking", "balances": {"current": 5000.0}}
        adapted = plaid_ingest.adapt_pl_account(raw, "Charles Schwab")
        self.assertEqual(plaid_ingest.new_account_fields(adapted, raw, "Charles Schwab", "2026-09-15")["type"],
                         "bank_account")

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


class PendingDeletes(unittest.TestCase):
    """PEND-004. The sweep that heals orphaned holds must not eat live ones.

    Scenario throughout: one hold we wrote earlier (`pending_pl_HOLD`) that is STILL
    pending, plus whatever this run reported.
    """
    EXISTING = {"pending_pl_HOLD", "pl_POSTED", "pending_pl_OTHER"}

    def test_incremental_run_keeps_a_hold_it_did_not_re_report(self):
        # The bug this pins: /transactions/sync reports a still-pending row ONCE.
        # A delta carrying only an unrelated posted row used to delete every hold
        # inside MATCH_DAYS of it.
        self.assertEqual(
            plaid_ingest.pending_deletes_for(self.EXISTING, set(), [], full_walk=False),
            [])

    def test_removed_list_is_honoured_on_an_incremental_run(self):
        # Plaid's own signal: this hold posted or was declined. Always authoritative.
        self.assertEqual(
            plaid_ingest.pending_deletes_for(self.EXISTING, set(), ["HOLD"], full_walk=False),
            ["pending_pl_HOLD"])

    def test_full_walk_sweeps_holds_absent_from_the_fetch(self):
        # Cursor reset / first run: the fetch IS the whole picture, so absence means
        # gone. This is the orphan-healing the sweep was added for.
        self.assertEqual(
            plaid_ingest.pending_deletes_for(
                self.EXISTING, {"pending_pl_OTHER"}, [], full_walk=True),
            ["pending_pl_HOLD"])

    def test_full_walk_keeps_holds_it_re_reported(self):
        self.assertEqual(
            plaid_ingest.pending_deletes_for(
                self.EXISTING, {"pending_pl_HOLD", "pending_pl_OTHER"}, [], full_walk=True),
            [])

    def test_posted_rows_are_never_swept(self):
        # A removed POSTED row is a bank-side reversal — history is the owner's to edit.
        out = plaid_ingest.pending_deletes_for(self.EXISTING, set(), [], full_walk=True)
        self.assertNotIn("pl_POSTED", out)


class PendingLinkage(unittest.TestCase):
    """PEND-004. Explicit hold->posted linkage, so the twin guard never has to
    guess from amount and date."""

    def test_posted_row_carries_its_holds_doc_id(self):
        row = plaid_ingest.map_pl_txn(
            {"transaction_id": "posted1", "amount": 58.90, "date": "2026-08-09",
             "name": "RESTAURANT", "pending_transaction_id": "hold1"},
            "acct1", "chase")
        # Stored as the doc id we actually wrote the hold under, not the raw Plaid id,
        # so the read side can look it up without re-deriving the prefix.
        self.assertEqual(row["pendingTransactionId"], "pending_pl_hold1")
        self.assertIn("pendingTransactionId", plaid_ingest.PLAID_DOC_FIELDS)

    def test_absent_when_the_row_never_was_a_hold(self):
        row = plaid_ingest.map_pl_txn(
            {"transaction_id": "posted2", "amount": 12.34, "date": "2026-08-09",
             "name": "STARBUCKS"},
            "acct1", "chase")
        self.assertNotIn("pendingTransactionId", row)

    def test_amount_may_differ_from_the_hold_it_replaces(self):
        # A $50 authorization posting at $58.90 with a tip is the normal case, and the
        # reason amount-based twin matching was rejected.
        row = plaid_ingest.map_pl_txn(
            {"transaction_id": "posted3", "amount": 58.90, "date": "2026-08-09",
             "name": "RESTAURANT", "pending_transaction_id": "hold_at_50"},
            "acct1", "chase")
        self.assertEqual(row["amount"], 58.90)
        self.assertEqual(row["pendingTransactionId"], "pending_pl_hold_at_50")


if __name__ == "__main__":
    unittest.main()


class RemoveItem(unittest.TestCase):
    """#72 — deleting our copy of a token is not disconnecting the bank."""

    def test_remove_item_calls_plaid_with_the_token(self):
        seen = {}

        def fake_post(path, payload, timeout=60):
            seen["path"], seen["payload"] = path, payload
            return {"removed": True}

        plaid_ingest.remove_item("cid", "sec", "access-abc", post=fake_post)
        self.assertEqual(seen["path"], "/item/remove")
        self.assertEqual(seen["payload"]["access_token"], "access-abc")
        self.assertEqual(seen["payload"]["client_id"], "cid")
        self.assertEqual(seen["payload"]["secret"], "sec")

    def test_remove_item_propagates_failure(self):
        def failing_post(path, payload, timeout=60):
            raise RuntimeError("ITEM_NOT_FOUND")

        # Must NOT be swallowed: the caller decides whether to abort the deletion,
        # and it can only decide that if it hears about the failure.
        with self.assertRaises(RuntimeError):
            plaid_ingest.remove_item("cid", "sec", "access-abc", post=failing_post)
