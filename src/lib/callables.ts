import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '@/lib/firebase';
import type { ChatContext } from '@/lib/chat-actions';

// 2nd-gen callables, codebase "api", region us-central1
const functions = getFunctions(app, 'us-central1');

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Calls the aiDecision callable. Success: { success, explanation, riskLevel, fallback? }. Errors are thrown (HttpsError). */
export async function aiDecision(body: Record<string, unknown>): Promise<any> {
  return (await httpsCallable(functions, 'aiDecision')(body)).data;
}

/** Calls the parseReceipt callable. Success: { success, parsed, source }. Errors are thrown (HttpsError). */
export async function parseReceiptCallable(imageBase64: string, mimeType: string): Promise<any> {
  return (await httpsCallable(functions, 'parseReceipt')({ imageBase64, mimeType })).data;
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
  return (await httpsCallable(functions, 'aiChat')(body)).data;
}

/** Maps Firebase HttpsError codes to user-facing messages. */
export function callableErrorMessage(e: unknown): string {
  switch ((e as { code?: string } | null)?.code) {
    case 'functions/resource-exhausted':
      return 'Daily AI limit reached — try again tomorrow.';
    case 'functions/unauthenticated':
      return 'Please sign in again.';
    case 'functions/unavailable':
      return 'AI is not configured.';
    default:
      return 'AI request failed. Please try again.';
  }
}
