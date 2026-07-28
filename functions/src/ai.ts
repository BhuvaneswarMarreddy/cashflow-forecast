/**
 * aiDecision callable — port of src/app/api/ai/decision/route.ts.
 *
 * AI is an EXPLANATION LAYER ONLY - it never calculates balances.
 * Response shape matches the old route body: { success, explanation, riskLevel }
 * (panels read data.explanation), plus { fallback: true } on quota errors.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import OpenAI from 'openai';
import { AI_CONFIG, SYSTEM_PROMPT } from './ai-config';
import { buildPrompt, AiDecisionRequest } from './prompts';
import { checkRateLimit, LIMITS } from './rate-limit';

export const aiDecision = onCall(
  { secrets: ['OPENAI_API_KEY'], cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in to use AI features.');
    }
    await checkRateLimit(request.auth.uid, 'aiDecision', LIMITS.aiDecision);

    const body = (request.data || {}) as AiDecisionRequest;

    if (!process.env.OPENAI_API_KEY) {
      throw new HttpsError('unavailable', 'AI service not configured');
    }

    const userPrompt = buildPrompt(body.type, body);
    if (userPrompt === null) {
      throw new HttpsError('invalid-argument', 'Invalid request type');
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    try {
      const completion = await openai.chat.completions.create({
        model: AI_CONFIG.model,
        temperature: AI_CONFIG.temperature,
        max_tokens: AI_CONFIG.maxTokens,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      });

      const explanation =
        completion.choices[0]?.message?.content || 'Unable to generate explanation.';

      return {
        success: true,
        explanation,
        riskLevel: body.riskLevel || null,
      };
    } catch (error: unknown) {
      const err = error as { code?: string; status?: number; message?: string };
      console.error('AI API Error:', error);

      // Graceful fallback (verbatim from route)
      if (err?.code === 'insufficient_quota' || err?.status === 429) {
        return {
          success: true,
          explanation:
            'AI explanation temporarily unavailable. Please check the forecast numbers directly.',
          fallback: true,
        };
      }

      throw new HttpsError('internal', 'Failed to process request');
    }
  }
);
