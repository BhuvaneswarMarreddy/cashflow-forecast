/**
 * Firestore access for the two collections FIN-RELATION-001 adds:
 *
 *   users/{uid}/links/{linkId}                  — TransactionLink  (src/lib/relations.ts)
 *   users/{uid}/reviewCandidates/{identityKey}  — ReviewCandidate  (src/lib/candidates.ts)
 *
 * A NEW module rather than an edit to the 1190-line src/lib/firestore.ts, which is owned
 * upstream for the duration of this programme. That is a deliberate structural choice to
 * keep ownership disjoint — not a second data layer, just two collections that did not
 * exist before, in their own file.
 *
 * This module holds no rules of its own. Every write runs the SAME pure validator the
 * parser and the tests use, so there is one place that decides what a legal allocation
 * is. It writes ZERO fields on users/{uid}/transactions/{id}: a relationship is stored
 * BESIDE a transaction, never inside it, so provider description, provider category,
 * amount, provider transaction id and posted date are untouchable from here.
 *
 * There is no delete path. A rejected link IS the suppression record, and a decision is
 * a record — firestore.rules denies delete on both collections to match.
 */

import { collection, db, doc, getDocs, setDoc } from './firebase';
import { ReviewCandidate, sanitizeEvidence } from './candidates';
import {
  LinkDraft,
  LinkValidationContext,
  RuleId,
  TransactionLink,
  buildLink,
  validateLink,
} from './relations';
import { emit } from './obs/events';
import { startSpan } from './obs/trace';

const linksPath = (uid: string) => collection(db, 'users', uid, 'links');
const candidatesPath = (uid: string) => collection(db, 'users', uid, 'reviewCandidates');

/** Firestore rejects `undefined`; optional fields are omitted, not nulled. */
const defined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export type StoreResult<T> = { ok: true; value: T } | { ok: false; ruleId: RuleId };

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getLinks(uid: string): Promise<TransactionLink[]> {
  // Repository boundary: record count + duration + collection SHAPE, never documents.
  const span = startSpan('Firestore.GetLinks', {
    repository: 'relations-store.getLinks',
    dataSource: 'Firestore',
    metadata: { collection: 'users/{uid}/links' },
  });
  try {
    const snapshot = await getDocs(linksPath(uid));
    const links = snapshot.docs.map((d) => ({ ...(d.data() as Omit<TransactionLink, 'id'>), id: d.id }));
    span.end({ recordCount: links.length });
    return links;
  } catch (error) {
    span.end({ status: 'error', error });
    throw error;
  }
}

export async function getReviewCandidates(uid: string): Promise<ReviewCandidate[]> {
  const span = startSpan('Firestore.GetReviewCandidates', {
    repository: 'relations-store.getReviewCandidates',
    dataSource: 'Firestore',
    metadata: { collection: 'users/{uid}/reviewCandidates' },
  });
  try {
    const snapshot = await getDocs(candidatesPath(uid));
    const candidates = snapshot.docs.map((d) => ({ ...(d.data() as Omit<ReviewCandidate, 'id'>), id: d.id }));
    span.end({ recordCount: candidates.length });
    return candidates;
  } catch (error) {
    span.end({ status: 'error', error });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Writes — upserts, because the ids are derived
// ---------------------------------------------------------------------------

/**
 * Validate then upsert one link. The doc id is `linkType~source~target`, so calling this
 * twice with the same relation updates one document instead of creating a second.
 *
 * Callers follow the existing optimistic contract (src/context/TransactionContext.tsx):
 * update local state, fire this, surface a rejection visibly. With offline persistence
 * on, awaiting the server ack hangs until the network returns.
 */
export async function saveLink(
  uid: string,
  draft: LinkDraft & { createdAt?: string; updatedAt?: string },
  ctx: LinkValidationContext
): Promise<StoreResult<TransactionLink>> {
  const built = buildLink(draft, ctx);
  if (!built.ok) return built;

  const span = startSpan('Firestore.SaveLink', {
    repository: 'relations-store.saveLink',
    dataSource: 'Firestore',
    metadata: { collection: 'users/{uid}/links', linkType: built.link.linkType, status: built.link.status },
  });
  try {
    await setDoc(doc(linksPath(uid), built.link.id), defined(built.link), { merge: true });
    span.end({ recordCount: 1 });
    emitLinkStatus(built.link, draft.status);
    return { ok: true, value: built.link };
  } catch (error) {
    span.end({ status: 'error', error });
    throw error;
  }
}

/** One event per status that means something. Enum values and counts only. */
function emitLinkStatus(link: TransactionLink, previousStatus?: string): void {
  const shared = {
    eventCategory: 'activity' as const,
    traceId: '',
    component: 'RecoveryRelations',
    resultStatus: 'ok' as const,
  };
  if (link.status === 'confirmed') {
    emit({ ...shared, eventName: 'Relation.LinkConfirmed', metadata: { linkType: link.linkType, allocationCount: 1 } });
  } else if (link.status === 'superseded') {
    emit({ ...shared, eventName: 'Relation.LinkSuperseded', metadata: { linkType: link.linkType, previousStatus } });
  } else if (link.status === 'rejected') {
    emit({ ...shared, eventName: 'Relation.LinkRejected', metadata: { linkType: link.linkType, previousStatus } });
  }
}

/** Upsert one candidate against its identityKey, with evidence stripped to safe keys. */
export async function saveReviewCandidate(uid: string, candidate: ReviewCandidate): Promise<ReviewCandidate> {
  const clean: ReviewCandidate = { ...candidate, evidence: sanitizeEvidence(candidate.evidence) };
  const span = startSpan('Firestore.SaveReviewCandidate', {
    repository: 'relations-store.saveReviewCandidate',
    dataSource: 'Firestore',
    metadata: {
      collection: 'users/{uid}/reviewCandidates',
      candidateType: clean.candidateType,
      algorithmVersion: clean.algorithmVersion,
      status: clean.status,
    },
  });
  try {
    await setDoc(doc(candidatesPath(uid), clean.id), defined(clean), { merge: true });
    span.end({ recordCount: 1 });
    return clean;
  } catch (error) {
    span.end({ status: 'error', error });
    throw error;
  }
}

/**
 * Record the owner's decision on a candidate WITHOUT rewriting the evidence or the
 * score. Terminal statuses are never re-scored, so a decision cannot drift.
 */
export async function recordCandidateDecision(
  uid: string,
  identityKey: string,
  status: ReviewCandidate['status'],
  extra: { linkIds?: string[]; reviewedAt?: string } = {}
): Promise<void> {
  const span = startSpan('Firestore.RecordCandidateDecision', {
    repository: 'relations-store.recordCandidateDecision',
    dataSource: 'Firestore',
    metadata: { collection: 'users/{uid}/reviewCandidates', status, linkCount: extra.linkIds?.length ?? 0 },
  });
  try {
    await setDoc(
      doc(candidatesPath(uid), identityKey),
      defined({ status, reviewedBy: 'user' as const, reviewedAt: extra.reviewedAt ?? new Date().toISOString(), linkIds: extra.linkIds }),
      { merge: true }
    );
    span.end({ recordCount: 1 });
  } catch (error) {
    span.end({ status: 'error', error });
    throw error;
  }
}

/**
 * The one application-service span: validate every proposed link, write them, then
 * record the decision. All-or-nothing on validation — a partially-applied allocation is
 * a worse outcome than a refused one, so nothing is written unless everything validates.
 *
 * This is the ONLY path from a proposal to a stored confirmation, and it is reached only
 * from an explicit owner confirmation. A model response never calls it.
 */
export async function confirmCandidate(
  uid: string,
  candidate: ReviewCandidate,
  ctx: LinkValidationContext,
  options: { algorithmVersion?: string; confirmedAt?: string } = {}
): Promise<StoreResult<TransactionLink[]>> {
  const span = startSpan('Relation.ConfirmCandidate', {
    service: 'relations-store.confirmCandidate',
    component: 'RecoveryRelations',
    metadata: {
      candidateType: candidate.candidateType,
      algorithmVersion: candidate.algorithmVersion,
      allocationCount: candidate.proposedLinks.length,
    },
  });

  const confirmedAt = options.confirmedAt ?? new Date().toISOString();
  const drafts: LinkDraft[] = candidate.proposedLinks.map((p) => ({
    ...p,
    status: 'confirmed' as const,
    confirmedAt,
    confirmedBy: 'user' as const,
    algorithmVersion: options.algorithmVersion ?? candidate.algorithmVersion,
    candidateId: candidate.candidateId,
  }));

  // Validate the whole set first, accumulating what each one contributes, so an
  // over-allocation across two proposals in the same batch is caught before any write.
  const accumulated = [...(ctx.links ?? [])];
  for (const draft of drafts) {
    const check = validateLink(draft, { ...ctx, links: accumulated });
    if (!check.ok) {
      span.end({ status: 'error', metadata: { ruleId: check.ruleId } });
      return check;
    }
    const built = buildLink(draft, { ...ctx, links: accumulated });
    if (built.ok) accumulated.push(built.link);
  }

  try {
    const written: TransactionLink[] = [];
    for (const draft of drafts) {
      const result = await saveLink(uid, draft, { ...ctx, links: accumulated });
      if (!result.ok) {
        span.end({ status: 'error', metadata: { ruleId: result.ruleId } });
        return result;
      }
      written.push(result.value);
    }
    await recordCandidateDecision(uid, candidate.id, 'confirmed', { linkIds: written.map((l) => l.id), reviewedAt: confirmedAt });
    span.end({ recordCount: written.length, metadata: { allocationCount: written.length } });
    return { ok: true, value: written };
  } catch (error) {
    span.end({ status: 'error', error });
    throw error;
  }
}
