/**
 * FIN-RELATION-001 §11.2 — the review-candidate model (C1–C8).
 *
 * Every fixture is INVENTED. The whole point of C3/C4 is that a decision the owner
 * already made can never be asked again, including across an algorithm version bump.
 */

import {
  CandidateEvidence,
  CandidateStatus,
  MAX_CANDIDATE_TRANSACTIONS,
  ReviewCandidate,
  buildCandidateId,
  buildIdentityKey,
  isTerminalCandidateStatus,
  mergeCandidateRun,
  rankCandidates,
  sanitizeEvidence,
} from '@/lib/candidates';

const V1 = 'refund-match-v1';
const V2 = 'refund-match-v2';

const EVIDENCE: CandidateEvidence = {
  amountsCents: [110000, 10000, 120000],
  dayGaps: [2, 17],
  sameAccount: true,
  accountTypes: ['credit_card'],
  merchantMatch: 'exact',
  referenceOverlap: 'none',
  pendingInvolved: false,
  reasonCodes: ['exact_amount', 'same_account'],
};

const candidate = (over: Partial<ReviewCandidate> = {}): ReviewCandidate => {
  const candidateType = over.candidateType ?? 'combined_refund_match';
  const transactionIds = over.transactionIds ?? ['demo-purchase-a', 'demo-purchase-b', 'demo-refund-ab'];
  const algorithmVersion = over.algorithmVersion ?? V1;
  return {
    id: buildIdentityKey(candidateType, transactionIds),
    candidateId: buildCandidateId(candidateType, algorithmVersion, transactionIds),
    candidateType,
    algorithmVersion,
    transactionIds: [...transactionIds].sort(),
    status: 'unreviewed',
    proposedLinks: [
      { linkType: 'refund_of', sourceTransactionId: 'demo-refund-ab', targetTransactionId: 'demo-purchase-a', allocatedAmountCents: 110000 },
      { linkType: 'refund_of', sourceTransactionId: 'demo-refund-ab', targetTransactionId: 'demo-purchase-b', allocatedAmountCents: 10000 },
    ],
    evidence: EVIDENCE,
    score: 0.9,
    generatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
};

describe('C1 deterministic identity', () => {
  it('yields one identityKey for the same rows in three discovery orders', () => {
    const orders = [
      ['demo-purchase-a', 'demo-purchase-b', 'demo-refund-ab'],
      ['demo-refund-ab', 'demo-purchase-a', 'demo-purchase-b'],
      ['demo-purchase-b', 'demo-refund-ab', 'demo-purchase-a'],
    ];
    const keys = orders.map((ids) => buildIdentityKey('combined_refund_match', ids));
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('combined_refund_match~demo-purchase-a~demo-purchase-b~demo-refund-ab');
  });

  it('throws rather than emitting an ambiguous key when an id carries the separator', () => {
    expect(() => buildIdentityKey('refund_match', ['demo~odd', 'demo-refund-ab'])).toThrow(/~/);
  });
});

describe('C2 identityKey omits the version, candidateId carries it', () => {
  it('produces two distinct strings on the same document', () => {
    const c = candidate();
    expect(c.id).toBe('combined_refund_match~demo-purchase-a~demo-purchase-b~demo-refund-ab');
    expect(c.candidateId).toBe('combined_refund_match~refund-match-v1~demo-purchase-a~demo-purchase-b~demo-refund-ab');
    expect(c.id).not.toBe(c.candidateId);
    expect(c.id).not.toContain(V1);
    expect(c.candidateId).toContain(V1);
  });
});

describe('C3 a dismissed candidate is never re-emitted', () => {
  it('drops it from the second generator run', () => {
    const stored = candidate({ status: 'dismissed', reviewedAt: '2026-08-01T12:00:00.000Z', reviewedBy: 'user' });
    const regenerated = candidate();

    const run = mergeCandidateRun([regenerated], [stored]);

    expect(run.writes).toHaveLength(0);
    expect(run.suppressed).toEqual([stored.id]);
    expect(run.unchanged).toEqual([stored]);
  });
});

describe('C4 suppression survives an algorithm version bump', () => {
  it('bumping refund-match-v1 -> v2 does not resurrect a dismissal', () => {
    const stored = candidate({ status: 'dismissed' });
    // The v2 generator rediscovers the same rows and mints a new candidateId…
    const regenerated = candidate({ algorithmVersion: V2 });
    expect(regenerated.candidateId).not.toBe(stored.candidateId);
    // …but the SAME identityKey, which is the document the dismissal lives on.
    expect(regenerated.id).toBe(stored.id);

    const run = mergeCandidateRun([regenerated], [stored]);
    expect(run.writes).toHaveLength(0);
    expect(run.suppressed).toEqual([stored.id]);
  });
});

describe('C5 a version bump re-evaluates only unreviewed candidates', () => {
  const untouched: CandidateStatus[] = ['confirmed', 'dismissed', 'intentional', 'needs_more_information'];

  it.each(untouched)('leaves a %s candidate untouched, algorithmVersion included', (status) => {
    const stored = candidate({ status, transactionIds: [`demo-a-${status}`, `demo-b-${status}`] });
    const regenerated = candidate({ status: 'unreviewed', algorithmVersion: V2, score: 0.2, transactionIds: [`demo-a-${status}`, `demo-b-${status}`] });

    const run = mergeCandidateRun([regenerated], [stored]);

    expect(run.writes).toHaveLength(0);
    expect(run.unchanged[0]).toEqual(stored);
    expect(run.unchanged[0].algorithmVersion).toBe(V1);
    expect(run.unchanged[0].status).toBe(status);
  });

  it('rewrites an unreviewed candidate with the new version and score', () => {
    const stored = candidate({ status: 'unreviewed', score: 0.4 });
    const regenerated = candidate({ algorithmVersion: V2, score: 0.8 });

    const run = mergeCandidateRun([regenerated], [stored]);

    expect(run.writes).toHaveLength(1);
    expect(run.writes[0].algorithmVersion).toBe(V2);
    expect(run.writes[0].score).toBe(0.8);
    expect(run.writes[0].id).toBe(stored.id);
    expect(run.suppressed).toHaveLength(0);
  });

  it('writes a candidate that has never been seen', () => {
    const run = mergeCandidateRun([candidate()], []);
    expect(run.writes).toHaveLength(1);
    expect(run.writes[0].status).toBe('unreviewed');
  });

  it('agrees with isTerminalCandidateStatus on the closed set', () => {
    expect((['confirmed', 'dismissed', 'intentional'] as CandidateStatus[]).every(isTerminalCandidateStatus)).toBe(true);
    expect((['unreviewed', 'suggested', 'needs_more_information'] as CandidateStatus[]).some(isTerminalCandidateStatus)).toBe(false);
  });
});

describe('C6 intentional suppresses the alert, not the money', () => {
  it('drops the alert while the candidate carries nothing that could reduce a total', () => {
    const stored = candidate({ candidateType: 'duplicate_subscription', status: 'intentional' });
    const run = mergeCandidateRun([candidate({ candidateType: 'duplicate_subscription' })], [stored]);

    expect(run.writes).toHaveLength(0);
    expect(run.suppressed).toEqual([stored.id]);

    // A candidate is a question about an alert. It has no field that changes an amount.
    const forbidden = ['amount', 'amountCents', 'adjustmentCents', 'excludeFromTotals', 'netEconomicCostCents', 'type', 'category'];
    expect(Object.keys(stored).filter((k) => forbidden.includes(k))).toEqual([]);
  });
});

describe('C7 the transaction-id cap keeps the doc id inside Firestore limits', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `demo-row-${String(i).padStart(2, '0')}`);

  it('accepts exactly 13 and the resulting id is well under 1500 bytes', () => {
    expect(MAX_CANDIDATE_TRANSACTIONS).toBe(13);
    const key = buildIdentityKey('combined_refund_match', ids(13));
    expect(new TextEncoder().encode(key).length).toBeLessThan(1500);
  });

  it('rejects 14', () => {
    expect(() => buildIdentityKey('combined_refund_match', ids(14))).toThrow(/13/);
  });

  it('rejects fewer than 2', () => {
    expect(() => buildIdentityKey('refund_match', ['demo-row-00'])).toThrow(/2/);
  });
});

describe('C8 evidence carries no free text', () => {
  it('strips merchant strings, titles, descriptions, account names and lastFourDigits', () => {
    const hostile = {
      ...EVIDENCE,
      merchant: 'DEMO AMAZON',
      title: 'Demo Amazon Lens',
      description: 'Demo card ending 9021',
      accountName: 'Demo Rewards Card',
      lastFourDigits: '9021',
      serviceFamilyLabel: 'Demo Streaming',
      aliases: ['DEMO AMAZON MKTPL'],
    };

    const clean = sanitizeEvidence(hostile);

    expect(Object.keys(clean).sort()).toEqual(Object.keys(EVIDENCE).sort());
    for (const banned of ['merchant', 'title', 'description', 'accountName', 'lastFourDigits', 'serviceFamilyLabel', 'aliases']) {
      expect(clean).not.toHaveProperty(banned);
    }
    // and nothing that survives is free text
    expect(JSON.stringify(clean)).not.toMatch(/AMAZON|Lens|9021|Rewards/i);
  });

  it('ranks deterministically: score desc, then generatedAt asc, then id asc', () => {
    const a = candidate({ transactionIds: ['demo-a1', 'demo-a2'], score: 0.5, generatedAt: '2026-08-01T00:00:00.000Z' });
    const b = candidate({ transactionIds: ['demo-b1', 'demo-b2'], score: 0.9, generatedAt: '2026-08-02T00:00:00.000Z' });
    const c = candidate({ transactionIds: ['demo-c1', 'demo-c2'], score: 0.5, generatedAt: '2026-07-31T00:00:00.000Z' });

    expect(rankCandidates([a, b, c]).map((x) => x.id)).toEqual([b.id, c.id, a.id]);
    expect(rankCandidates([c, b, a]).map((x) => x.id)).toEqual(rankCandidates([a, b, c]).map((x) => x.id));
  });
});
