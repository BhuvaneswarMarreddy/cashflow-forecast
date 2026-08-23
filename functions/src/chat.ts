/**
 * aiChat callable — turns "anything from Instacart is Groceries" into a mapping rule.
 *
 * Same shape as aiDecision: auth guard, per-uid daily rate limit, OPENAI_API_KEY secret,
 * graceful fallback on quota. Temperature 0 + JSON mode, because the output is parsed,
 * not read. The client re-validates everything in src/lib/chat-actions.ts — this return
 * value is untrusted model output, not an API contract the UI can lean on.
 *
 * Returns { success: true, result: { action, rule?, explanation }, fallback? }.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import OpenAI from 'openai';
import { AI_CONFIG } from './ai-config';
import { buildChatMessages, AiChatRequest } from './prompts';
import { checkRateLimit, LIMITS } from './rate-limit';

// Generic "the model gave nothing back" fallback — JSON mode returned empty
// content with no parse error to explain why. Not a quota/rate-limit case;
// see OUT_OF_CREDIT/RATE_LIMITED below for those.
const UNAVAILABLE = {
  action: 'answer',
  explanation: "That didn't come back with an answer. Try asking again.",
};

/**
 * OpenAI's own error `code` on a 429 tells the two quota failures apart:
 * `insufficient_quota` is the account out of prepaid credit — retrying does
 * nothing until the owner adds credit. A 429 with any other (or no) code is
 * the per-minute rate limit — retrying in a bit works fine. This is
 * https://platform.openai.com/docs/guides/error-codes's own distinction, not
 * a guess: `openai`'s RateLimitError carries the JSON body's `code` verbatim.
 */
const OUT_OF_CREDIT = {
  action: 'answer' as const,
  explanation:
    'The OpenAI account behind this chat is out of credit. Add credit at platform.openai.com/billing, then ask again.',
};

const RATE_LIMITED = {
  action: 'answer' as const,
  explanation: 'OpenAI is rate-limiting this account right now. Wait a few minutes and try again.',
};

/**
 * What the owner sees when the OpenAI call itself failed with a quota error.
 * Exported (mirrors `truncatedReply`) so tests pin the branching, not just
 * the copy. Returns `null` for anything that isn't one of the two quota
 * shapes — the caller then falls through to the generic 500.
 */
export function quotaFallback(err: { code?: string; status?: number }): {
  success: true;
  result: { action: 'answer'; explanation: string };
  fallback: true;
} | null {
  if (err?.code === 'insufficient_quota') {
    return { success: true, result: OUT_OF_CREDIT, fallback: true };
  }
  if (err?.status === 429) {
    return { success: true, result: RATE_LIMITED, fallback: true };
  }
  return null;
}

/**
 * Image turns are rare (rate-limited, personal app) and gpt-4o-mini's weaker vision is
 * what users actually notice — a crisp Apple Card installment screenshot came back
 * "I cannot read the details from the image." This is the receipt scanner's quality
 * problem class solved at the source, for chat: pay for the stronger vision model only
 * on the turns that carry an image; text-only turns keep the cheap configured model.
 */
export function modelFor(hasImage: boolean): string {
  return hasImage ? 'gpt-4o' : AI_CONFIG.model;
}

/**
 * Success-log fields — counts/booleans only, never merchant text, figures or base64.
 * The narrow return type is the enforcement: a future field has to fit boolean | number,
 * not free text.
 */
/**
 * What the owner sees when the model hit `max_tokens` mid-answer. The raw
 * fragment would be invalid JSON rendered as a chat bubble; this says what
 * actually happened and how to get the answer.
 */
export function truncatedReply(): {
  success: true;
  result: { action: 'answer'; explanation: string };
  fallback: true;
} {
  return {
    success: true,
    result: {
      action: 'answer',
      explanation:
        'That answer came out too long to send in one piece — ask for a narrower slice (fewer months or fewer categories) and I can show it.',
    },
    fallback: true,
  };
}

export function successLogFields(
  hasImage: boolean,
  durationMs: number,
  truncated: boolean
): { hasImage: boolean; durationMs: number; truncated: boolean } {
  return { hasImage, durationMs, truncated };
}

export const aiChat = onCall(
  {
    secrets: ['OPENAI_API_KEY'],
    cors: true,
    // A base64 screenshot can ride along now (see prompts.ts's CHAT_IMAGE_CAPS) — same
    // room receipt.ts gives its vision calls.
    memory: '512MiB',
    timeoutSeconds: 120,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in to use AI features.');
    }
    await checkRateLimit(request.auth.uid, 'aiChat', LIMITS.aiChat);

    const body = (request.data || {}) as AiChatRequest;
    if (typeof body.message !== 'string' || !body.message.trim()) {
      throw new HttpsError('invalid-argument', 'Message is required.');
    }

    if (!process.env.OPENAI_API_KEY) {
      throw new HttpsError('unavailable', 'AI service not configured');
    }

    // Built (and validated — CHAT_IMAGE_CAPS) outside the try below, so a bad image throws
    // its real invalid-argument code instead of being flattened into the generic 'internal'
    // catch-all meant for OpenAI call failures.
    const messages = buildChatMessages(body);
    const hasImage = Boolean(body.imageBase64);
    const startedAt = Date.now();

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    try {
      const completion = await openai.chat.completions.create({
        model: modelFor(hasImage),
        temperature: 0,
        // A `report` table is the biggest reply this endpoint can produce: an
        // ordinary "compare July to August" breakdown measures 500-740 tokens
        // and the parser's own caps (30 rows x 6 columns) top out near 1300.
        // At 500 the JSON truncated mid-table, JSON.parse threw, and the owner
        // got raw broken JSON in a chat bubble. 1600 clears the measured
        // ceiling with headroom; output cost at this size is ~$0.001/request.
        max_tokens: 1600,
        response_format: { type: 'json_object' },
        messages,
      });

      const content = completion.choices[0]?.message?.content || '';
      const truncated = completion.choices[0]?.finish_reason === 'length';
      // Counts only — never the message, merchant names or base64. See applyDecision's
      // console.log for the same discipline elsewhere in this codebase. Logged before
      // the truncation branch returns, so a truncated turn is visible in logs, not
      // just to the owner — otherwise there is no way to notice max_tokens starting
      // to bite as the prompt grows.
      console.log('aiChat', successLogFields(hasImage, Date.now() - startedAt, truncated));
      // A truncated completion is never valid JSON, and echoing the fragment
      // back as prose shows the owner a broken object. Say what happened.
      if (truncated) return truncatedReply();
      try {
        return { success: true, result: JSON.parse(content) };
      } catch {
        // JSON mode failed us — hand the text back as a plain answer rather than 500.
        return { success: true, result: { action: 'answer', explanation: content || UNAVAILABLE.explanation } };
      }
    } catch (error: unknown) {
      const err = error as { code?: string; status?: number };
      console.error('AI Chat Error:', error);

      const quotaReply = quotaFallback(err);
      if (quotaReply) return quotaReply;
      throw new HttpsError('internal', 'Failed to process request');
    }
  }
);
