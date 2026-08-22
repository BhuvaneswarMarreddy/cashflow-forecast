import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '@/lib/firebase';
import type { ChatContext } from '@/lib/chat-actions';
import type { MappingRule, RuleMatch } from '@/lib/mapping-rules';

// 2nd-gen callables, codebase "api", region us-central1. Lazy — computed on the
// first actual call, not at module load. #130 made TransactionContext.tsx (nearly
// every page's import graph) pull this file in transitively via addRule(); an
// eager getFunctions(app, ...) here required a fully-initialized Firebase app in
// every test that merely renders a page, not just the ones that call a callable.
// getFunctions() is cheap to call repeatedly (the SDK caches by app+region), so
// this costs nothing on the path that does call it.
let cachedFunctions: ReturnType<typeof getFunctions> | undefined;
const functions = (): ReturnType<typeof getFunctions> =>
  (cachedFunctions ??= getFunctions(app, 'us-central1'));

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Calls the aiDecision callable. Success: { success, explanation, riskLevel, fallback? }. Errors are thrown (HttpsError). */
export async function aiDecision(body: Record<string, unknown>): Promise<any> {
  return (await httpsCallable(functions(), 'aiDecision')(body)).data;
}

/** Calls the parseReceipt callable. Success: { success, parsed, source }. Errors are thrown (HttpsError). */
export async function parseReceiptCallable(imageBase64: string, mimeType: string): Promise<any> {
  return (await httpsCallable(functions(), 'parseReceipt')({ imageBase64, mimeType })).data;
}

/**
 * Calls the aiChat callable. Success: { success, result, fallback? } where `result` is
 * UNTRUSTED model output — run it through parseChatAction() before using it.
 */
export async function aiChat(body: {
  message: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  context?: ChatContext;
}): Promise<any> {
  return (await httpsCallable(functions(), 'aiChat')(body)).data;
}

/**
 * What applyDecision's callable hands back — mirrors functions/src/decisions.ts's
 * own `ChangeSummary` exactly, but is redefined here rather than imported: that
 * file lives in the functions/ build (its own tsconfig, deployed separately) and
 * is outside this app's `@/*` path, so there is nothing to import from. Counts
 * only — never the transactions themselves.
 */
export type ChangeSummary = { transactionsMatched: number; monthsAffected: string[] };

/**
 * Calls the applyDecision callable — the ONE validated write path for a
 * merchant→category rule (functions/src/decisions.ts), shared with the mobile
 * app. The server checks every key/value (category must be a real
 * ExpenseCategory, etc.) and writes the rule doc + its audit entry atomically;
 * this is why TransactionContext.addRule no longer calls `setDoc` on
 * users/{uid}/rules directly. Errors are thrown (HttpsError): 'unauthenticated' |
 * 'invalid-argument' | 'not-found'.
 */
export async function applyDecision(op: {
  kind: 'merchantRule';
  match: RuleMatch;
  set: MappingRule['set'];
}): Promise<{ decisionId: string; changed: ChangeSummary }> {
  return (await httpsCallable(functions(), 'applyDecision')(op)).data as {
    decisionId: string;
    changed: ChangeSummary;
  };
}

/**
 * Calls the undoDecision callable — disables a rule applyDecision wrote
 * (`enabled: false` + its own audit entry), never deletes it. No caller in the
 * browser yet (TransactionContext's deleteRule/toggleRule are the closest thing
 * and are out of #130's scope); this wrapper exists for parity with the mobile
 * client, which already calls it. Errors are thrown (HttpsError).
 */
export async function undoDecision(decisionId: string): Promise<{ ok: true }> {
  return (await httpsCallable(functions(), 'undoDecision')({ decisionId })).data as { ok: true };
}

/**
 * Maps Firebase HttpsError codes to user-facing messages. `fallback` exists
 * because the default wording ("AI request failed") is wrong for a non-AI
 * callable — applyDecision failing is not the AI being unavailable, it's a rule
 * that didn't save — so a caller for a different callable can supply its own
 * default while still getting the shared, code-specific messages below.
 */
export function callableErrorMessage(e: unknown, fallback = 'AI request failed. Please try again.'): string {
  switch ((e as { code?: string } | null)?.code) {
    case 'functions/resource-exhausted':
      return 'Daily AI limit reached — try again tomorrow.';
    case 'functions/unauthenticated':
      return 'Please sign in again.';
    case 'functions/unavailable':
      return 'AI is not configured.';
    default:
      return fallback;
  }
}
