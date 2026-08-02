/**
 * FIN-RELATION-001 §11.4 — the thirteen structured recovery actions (P1–P13).
 *
 * The parser is the trust boundary: the callable returns model output, so every payload
 * here is treated as hostile. One test per rejection rule, plus P13's proof that a VALID
 * action still writes nothing — the store spy must stay at zero calls.
 *
 * All fixtures invented: demo-purchase-a $1,100.00, demo-purchase-b $100.00,
 * demo-refund-ab $1,200.00 on demo-card-9021.
 */

jest.mock('@/lib/relations-store', () => ({
  getLinks: jest.fn(),
  getReviewCandidates: jest.fn(),
  saveLink: jest.fn(),
  saveReviewCandidate: jest.fn(),
  confirmCandidate: jest.fn(),
  recordCandidateDecision: jest.fn(),
}));

import { parseChatAction, RecoveryContext } from '@/lib/chat-actions';
import { buildCandidateId, buildIdentityKey, CandidateEvidence, ReviewCandidate } from '@/lib/candidates';
import * as store from '@/lib/relations-store';

const V = 'refund-match-v1';
const IDS = ['demo-purchase-a', 'demo-purchase-b', 'demo-refund-ab'];

const EVIDENCE: CandidateEvidence = {
  amountsCents: [110000, 10000, 120000],
  dayGaps: [2, 17],
  sameAccount: true,
  accountTypes: ['credit_card'],
  merchantMatch: 'exact',
  referenceOverlap: 'none',
  pendingInvolved: false,
  reasonCodes: ['exact_amount'],
};

const CANDIDATE: ReviewCandidate = {
  id: buildIdentityKey('combined_refund_match', IDS),
  candidateId: buildCandidateId('combined_refund_match', V, IDS),
  candidateType: 'combined_refund_match',
  algorithmVersion: V,
  transactionIds: [...IDS].sort(),
  status: 'unreviewed',
  proposedLinks: [
    { linkType: 'refund_of', sourceTransactionId: 'demo-refund-ab', targetTransactionId: 'demo-purchase-a', allocatedAmountCents: 110000 },
    { linkType: 'refund_of', sourceTransactionId: 'demo-refund-ab', targetTransactionId: 'demo-purchase-b', allocatedAmountCents: 10000 },
  ],
  evidence: EVIDENCE,
  score: 0.9,
  generatedAt: '2026-08-01T00:00:00.000Z',
};

const DUP_IDS = ['demo-sub-alpha', 'demo-sub-beta'];
const DUP_CANDIDATE: ReviewCandidate = {
  id: buildIdentityKey('duplicate_subscription', DUP_IDS),
  candidateId: buildCandidateId('duplicate_subscription', 'duplicate-subscription-v1', DUP_IDS),
  candidateType: 'duplicate_subscription',
  algorithmVersion: 'duplicate-subscription-v1',
  transactionIds: [...DUP_IDS].sort(),
  status: 'unreviewed',
  proposedLinks: [],
  evidence: { ...EVIDENCE, amountsCents: [2000, 2000], sameAccount: false, reasonCodes: ['different_account'] },
  score: 0.7,
  generatedAt: '2026-08-01T00:00:00.000Z',
};

const CTX: RecoveryContext = {
  candidates: [CANDIDATE, DUP_CANDIDATE],
  transactions: [
    { id: 'demo-purchase-a', amountCents: 110000 },
    { id: 'demo-purchase-b', amountCents: 10000 },
    { id: 'demo-refund-ab', amountCents: 120000 },
    { id: 'demo-sub-alpha', amountCents: 2000 },
    { id: 'demo-sub-beta', amountCents: 2000 },
    { id: 'demo-unrelated-row', amountCents: 8800 },
    { id: 'demo-disputed-charge', amountCents: 8800 },
  ],
};

const REASON = 'The owner confirmed this in the review panel.';
const alloc = (targetTransactionId: string, allocatedAmountCents: number) => ({ targetTransactionId, allocatedAmountCents });

const confirmPayload = (over: Record<string, unknown> = {}) => ({
  action: 'confirm_refund_allocation',
  candidateId: CANDIDATE.id,
  allocations: [alloc('demo-purchase-a', 110000), alloc('demo-purchase-b', 10000)],
  reason: REASON,
  ...over,
});

afterEach(() => jest.clearAllMocks());

describe('P1 an unknown action is rejected', () => {
  it.each(['delete_transaction', 'apply_all', 'mark_as_income', 'confirm_refund_allocations', ''])('rejects %p', (action) => {
    expect(parseChatAction({ action, candidateId: CANDIDATE.id, reason: REASON }, CTX)).toBeNull();
  });
});

describe('P2 unknown keys at any depth', () => {
  it('rejects an unknown key at the top level', () => {
    expect(parseChatAction(confirmPayload({ autoApply: true }), CTX)).toBeNull();
  });

  it('rejects an unknown key inside allocations[]', () => {
    expect(
      parseChatAction(
        confirmPayload({ allocations: [{ targetTransactionId: 'demo-purchase-a', allocatedAmountCents: 110000, force: true }] }),
        CTX
      )
    ).toBeNull();
  });
});

describe('P3 prototype-pollution keys at any depth', () => {
  it('rejects __proto__, constructor and prototype, and leaves Object.prototype clean', () => {
    const top = JSON.parse(
      `{"action":"dismiss_review_candidate","candidateId":${JSON.stringify(CANDIDATE.id)},"reason":${JSON.stringify(REASON)},"__proto__":{"polluted":true}}`
    );
    const nested = JSON.parse(
      `{"action":"confirm_refund_allocation","candidateId":${JSON.stringify(CANDIDATE.id)},"reason":${JSON.stringify(REASON)},"allocations":[{"targetTransactionId":"demo-purchase-a","allocatedAmountCents":110000,"__proto__":{"polluted":true}}]}`
    );
    const ctor = JSON.parse(
      `{"action":"dismiss_review_candidate","candidateId":${JSON.stringify(CANDIDATE.id)},"reason":${JSON.stringify(REASON)},"constructor":{"polluted":true}}`
    );
    const proto = JSON.parse(
      `{"action":"dismiss_review_candidate","candidateId":${JSON.stringify(CANDIDATE.id)},"reason":${JSON.stringify(REASON)},"prototype":{"polluted":true}}`
    );

    for (const payload of [top, nested, ctor, proto]) {
      expect(parseChatAction(payload, CTX)).toBeNull();
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});

describe('P4 an unknown candidateId', () => {
  it('is rejected — not looked up, not redirected', () => {
    expect(parseChatAction(confirmPayload({ candidateId: 'combined_refund_match~demo-nope~demo-nope-2' }), CTX)).toBeNull();
    expect(parseChatAction({ action: 'dismiss_review_candidate', candidateId: 'anything', reason: REASON }, CTX)).toBeNull();
  });

  it('is rejected when no recovery context was supplied at all', () => {
    expect(parseChatAction(confirmPayload())).toBeNull();
  });
});

describe('P5 a transaction id not in the ledger', () => {
  it('is rejected', () => {
    expect(parseChatAction({ action: 'mark_reward_credit', transactionId: 'demo-ghost-row', reason: REASON }, CTX)).toBeNull();
    expect(
      parseChatAction({ action: 'mark_chargeback_credit', transactionId: 'demo-ghost-row', targetTransactionId: 'demo-disputed-charge', allocatedAmountCents: 8800, reason: REASON }, CTX)
    ).toBeNull();
  });
});

describe('P6 containment: an id must belong to the referenced candidate', () => {
  it('rejects an allocation target that is in the ledger but not in the candidate', () => {
    expect(parseChatAction(confirmPayload({ allocations: [alloc('demo-unrelated-row', 8800)] }), CTX)).toBeNull();
  });

  it('rejects a keepTransactionId that is not in the candidate', () => {
    expect(
      parseChatAction({ action: 'confirm_duplicate_subscription', candidateId: DUP_CANDIDATE.id, keepTransactionId: 'demo-unrelated-row', reason: REASON }, CTX)
    ).toBeNull();
  });
});

describe('P7 non-integer, zero, negative, NaN or Infinity cents', () => {
  it.each([41.2, 0, -100, 110000.5])('rejects an allocation of %p', (cents) => {
    expect(parseChatAction(confirmPayload({ allocations: [alloc('demo-purchase-a', cents)] }), CTX)).toBeNull();
  });

  it('rejects NaN and Infinity, which JSON cannot carry but a hand-rolled object can', () => {
    expect(parseChatAction(confirmPayload({ allocations: [alloc('demo-purchase-a', NaN)] }), CTX)).toBeNull();
    expect(parseChatAction(confirmPayload({ allocations: [alloc('demo-purchase-a', Infinity)] }), CTX)).toBeNull();
    expect(parseChatAction(confirmPayload({ allocations: [alloc('demo-purchase-a', '110000' as unknown as number)] }), CTX)).toBeNull();
  });
});

describe('P8 the allocation total may not exceed the credit', () => {
  it('rejects rather than clamping, and the ledger is unchanged', () => {
    const before = JSON.stringify(CTX);
    expect(parseChatAction(confirmPayload({ allocations: [alloc('demo-purchase-a', 110000), alloc('demo-purchase-b', 20000)] }), CTX)).toBeNull();
    expect(JSON.stringify(CTX)).toBe(before);
  });
});

describe('P9 a single allocation may not exceed its target', () => {
  it('rejects $1,200.00 allocated against a $100.00 purchase', () => {
    expect(parseChatAction(confirmPayload({ allocations: [alloc('demo-purchase-b', 120000)] }), CTX)).toBeNull();
  });
});

describe('P10 an oversized allocation list is rejected, never truncated', () => {
  it('returns null for 13 allocations rather than a 12-element list', () => {
    const many = Array.from({ length: 13 }, () => alloc('demo-purchase-a', 1));
    const parsed = parseChatAction(confirmPayload({ allocations: many }), CTX);
    expect(parsed).toBeNull();
    expect(parsed).not.toEqual(expect.objectContaining({ allocations: expect.any(Array) }));
  });

  it('rejects an empty allocation list too — an allocation action that allocates nothing', () => {
    expect(parseChatAction(confirmPayload({ allocations: [] }), CTX)).toBeNull();
  });
});

describe('P11 an unsupported cardCreditKind', () => {
  it.each(['earned_income', 'salary', 'refund', 'Cashback_Reward', ''])('rejects %p', (kind) => {
    expect(parseChatAction({ action: 'classify_card_credit', transactionId: 'demo-refund-ab', cardCreditKind: kind, reason: REASON }, CTX)).toBeNull();
  });

  it('accepts a kind from the closed list', () => {
    expect(parseChatAction({ action: 'classify_card_credit', transactionId: 'demo-refund-ab', cardCreditKind: 'cashback_reward', reason: REASON }, CTX)).toEqual({
      action: 'classify_card_credit',
      transactionId: 'demo-refund-ab',
      cardCreditKind: 'cashback_reward',
      reason: REASON,
    });
  });
});

describe('P12 an empty reason after clipping', () => {
  it.each(['', '   ', '\n\t '])('rejects %p', (reason) => {
    expect(parseChatAction(confirmPayload({ reason }), CTX)).toBeNull();
    expect(parseChatAction({ action: 'dismiss_review_candidate', candidateId: CANDIDATE.id, reason }, CTX)).toBeNull();
  });

  it('rejects a missing reason', () => {
    const { reason, ...withoutReason } = confirmPayload();
    void reason;
    expect(parseChatAction(withoutReason, CTX)).toBeNull();
  });
});

describe('P13 every valid action parses, and nothing is written', () => {
  const valid: Record<string, unknown>[] = [
    confirmPayload(),
    confirmPayload({ action: 'adjust_refund_allocation', allocations: [alloc('demo-purchase-a', 90000)] }),
    { action: 'reject_refund_candidate', candidateId: CANDIDATE.id, reason: REASON },
    { action: 'classify_card_credit', transactionId: 'demo-refund-ab', cardCreditKind: 'merchant_refund', reason: REASON },
    { action: 'mark_reward_credit', transactionId: 'demo-refund-ab', reason: REASON },
    { action: 'mark_chargeback_credit', transactionId: 'demo-refund-ab', targetTransactionId: 'demo-disputed-charge', allocatedAmountCents: 8800, reason: REASON },
    { action: 'confirm_duplicate_charge', candidateId: DUP_CANDIDATE.id, reason: REASON },
    { action: 'confirm_duplicate_subscription', candidateId: DUP_CANDIDATE.id, keepTransactionId: 'demo-sub-alpha', reason: REASON },
    { action: 'mark_intentional_duplicate', candidateId: DUP_CANDIDATE.id, reason: REASON },
    { action: 'mark_different_owner', candidateId: DUP_CANDIDATE.id, reason: REASON },
    { action: 'mark_business_subscription', candidateId: DUP_CANDIDATE.id, reason: REASON },
    { action: 'mark_subscription_cancelled', candidateId: DUP_CANDIDATE.id, effectiveDate: '2026-07-31', reason: REASON },
    { action: 'dismiss_review_candidate', candidateId: CANDIDATE.id, reason: REASON },
  ];

  it('parses all thirteen', () => {
    expect(valid).toHaveLength(13);
    for (const payload of valid) {
      const parsed = parseChatAction(payload, CTX);
      expect(parsed).not.toBeNull();
      expect(parsed?.action).toBe(payload.action);
    }
  });

  it('writes nothing — the store spy stays at zero calls', () => {
    for (const payload of valid) parseChatAction(payload, CTX);
    for (const [name, fn] of Object.entries(store)) {
      expect([name, (fn as jest.Mock).mock.calls.length]).toEqual([name, 0]);
    }
  });

  it('normalises candidateId to the identityKey the store writes against', () => {
    const parsed = parseChatAction({ action: 'dismiss_review_candidate', candidateId: CANDIDATE.candidateId, reason: REASON }, CTX);
    expect(parsed).toEqual({ action: 'dismiss_review_candidate', candidateId: CANDIDATE.id, reason: REASON });
  });

  it('leaves the two pre-existing actions working exactly as before', () => {
    expect(parseChatAction({ action: 'answer', explanation: 'You spent $412 on dining in July.' })).toEqual({
      action: 'answer',
      explanation: 'You spent $412 on dining in July.',
    });
    expect(
      parseChatAction({
        action: 'create_rule',
        rule: { match: { field: 'title', op: 'contains', value: 'DEMO INSTACART' }, set: { category: 'food' } },
        explanation: 'Every row whose title contains DEMO INSTACART becomes Food & Dining.',
      })
    ).toMatchObject({ action: 'create_rule' });
  });
});
