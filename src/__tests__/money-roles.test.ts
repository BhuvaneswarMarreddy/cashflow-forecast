/**
 * MODEL-004 (#45) — the six roles, and the promises they make.
 *
 * The point of the layer is that "spending" can never inflate when money merely
 * moves. These tests pin that, plus the two owner decisions the mapping must not
 * quietly reverse, plus the exhaustiveness guard that stops a future meaning
 * from defaulting into Spent.
 */
import { FINANCIAL_MEANINGS, type FinancialMeaning } from '@/types';
import {
  MONEY_ROLES,
  ROLE_LABELS,
  ROLE_BLURBS,
  roleOf,
  meaningsInRole,
  unreachableRoles,
  totalsByRole,
} from '@/lib/money-roles';

describe('every meaning has exactly one role', () => {
  test.each(FINANCIAL_MEANINGS)('%s is assigned', (meaning) => {
    expect(MONEY_ROLES).toContain(roleOf(meaning as FinancialMeaning));
  });

  it('assigns every meaning — a new one cannot fall through into Spent', () => {
    // The exhaustiveness guard. Adding a value to FINANCIAL_MEANINGS without a
    // role would otherwise leave roleOf() returning undefined, and an undefined
    // bucket reads as zero rather than as an error.
    const unassigned = FINANCIAL_MEANINGS.filter((m) => !roleOf(m as FinancialMeaning));
    expect(unassigned).toEqual([]);
  });

  it('gives every role a label and a blurb', () => {
    for (const role of MONEY_ROLES) {
      expect(ROLE_LABELS[role]).toBeTruthy();
      expect(ROLE_BLURBS[role]).toBeTruthy();
    }
  });
});

describe('settlement and movement never count as spending', () => {
  it('a card payment is moved, not spent — the purchases were spending already', () => {
    expect(roleOf('card_payment')).toBe('transferred');
  });

  it('an internal transfer is moved', () => {
    expect(roleOf('internal_transfer')).toBe('transferred');
  });

  it('borrowing is moved, never earned', () => {
    // Cash and liability rise together. Counting it as income is how a loan
    // makes someone look richer.
    expect(roleOf('loan_proceeds')).toBe('transferred');
  });

  it('a chit-fund payout is moved, never earned', () => {
    expect(roleOf('chit_fund_payout')).toBe('transferred');
  });

  it('selling something is moved — an asset became cash', () => {
    expect(roleOf('sale_proceeds')).toBe('transferred');
  });

  it('a gift received is NOT earned', () => {
    // Earned drives runway and budgets; a gift is not pay and must not inflate it.
    expect(roleOf('gift_or_personal_transfer')).toBe('transferred');
  });

  it('an unclassified credit is never earned', () => {
    expect(roleOf('other_non_income_credit')).not.toBe('earned');
    expect(roleOf('unknown_inflow')).not.toBe('earned');
  });

  it('only actual pay is earned', () => {
    expect(meaningsInRole('earned')).toEqual(['earned_income']);
  });
});

describe("the owner's two decisions are preserved, not re-litigated", () => {
  it('a loan repayment counts as SPENT', () => {
    // "even loan payment is also spending" — the balance-sheet argument says
    // transferred, and the owner overruled it: in a cash-flow app the money
    // leaving each month is the thing to plan around.
    expect(roleOf('loan_repayment')).toBe('spent');
  });

  it('a chit-fund contribution counts as SPENT', () => {
    expect(roleOf('chit_fund_contribution')).toBe('spent');
  });
});

describe('money coming back is its own role, not negative spending', () => {
  it.each(['refund', 'shared_expense_reimbursement', 'receivable_repayment'] as const)(
    '%s is reimbursed',
    (m) => expect(roleOf(m)).toBe('reimbursed')
  );

  it('a reimbursable expense is still spent when it goes out', () => {
    // The claim arrives later as its own row; netting it here would hide the
    // outflow that actually happened.
    expect(roleOf('reimbursable_expense')).toBe('spent');
  });
});

describe('unreachable roles are declared honestly', () => {
  it('saved and invested have no meanings behind them yet', () => {
    // Not an oversight. AccountType is credit_card | debit_card | bank_account |
    // cash | personal_loan — there is no savings or investment account, so a
    // transfer into savings is indistinguishable from any other internal move.
    // A screen must not offer these as a category with a number beside it.
    expect(unreachableRoles().sort()).toEqual(['invested', 'saved']);
  });
});

describe('totalsByRole', () => {
  it('keeps a large settlement out of the spending total', () => {
    // The whole reason the layer exists: a $5,000 card payment beside $50 of
    // groceries must not read as $5,050 spent.
    const t = totalsByRole([
      { meaning: 'personal_expense', amount: 50 },
      { meaning: 'card_payment', amount: 5000 },
    ]);
    expect(t.spent).toBe(50);
    expect(t.transferred).toBe(5000);
  });

  it('sums every role independently', () => {
    const t = totalsByRole([
      { meaning: 'earned_income', amount: 4300 },
      { meaning: 'personal_expense', amount: 200 },
      { meaning: 'loan_repayment', amount: 250 },
      { meaning: 'internal_transfer', amount: 1000 },
      { meaning: 'refund', amount: 30 },
    ]);
    expect(t).toEqual({
      earned: 4300, spent: 450, transferred: 1000, reimbursed: 30,
      saved: 0, invested: 0,
    });
  });

  it('returns zeros for an empty ledger rather than throwing', () => {
    expect(totalsByRole([])).toEqual({
      earned: 0, spent: 0, saved: 0, invested: 0, transferred: 0, reimbursed: 0,
    });
  });
});
