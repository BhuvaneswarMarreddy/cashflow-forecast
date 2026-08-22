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

const UNAVAILABLE = {
  action: 'answer',
  explanation: 'AI chat is temporarily unavailable. You can add the rule by hand in Settings.',
};

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
export function successLogFields(hasImage: boolean, durationMs: number): { hasImage: boolean; durationMs: number } {
  return { hasImage, durationMs };
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
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages,
      });

      const content = completion.choices[0]?.message?.content || '';
      // Counts only — never the message, merchant names or base64. See applyDecision's
      // console.log for the same discipline elsewhere in this codebase.
      console.log('aiChat', successLogFields(hasImage, Date.now() - startedAt));
      try {
        return { success: true, result: JSON.parse(content) };
      } catch {
        // JSON mode failed us — hand the text back as a plain answer rather than 500.
        return { success: true, result: { action: 'answer', explanation: content || UNAVAILABLE.explanation } };
      }
    } catch (error: unknown) {
      const err = error as { code?: string; status?: number };
      console.error('AI Chat Error:', error);

      if (err?.code === 'insufficient_quota' || err?.status === 429) {
        return { success: true, result: UNAVAILABLE, fallback: true };
      }
      throw new HttpsError('internal', 'Failed to process request');
    }
  }
);
