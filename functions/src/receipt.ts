/**
 * parseReceipt callable — port of src/app/api/parse-receipt/route.ts.
 *
 * OpenAI gpt-4o-mini vision. Azure was a second provider for this same job and
 * was dropped 2026-08-02 — one vendor, one key, one thing to rotate.
 * Input: { imageBase64, mimeType } (client converts the file, no FormData).
 * Response shape matches the old route body: { success, parsed, source }.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { validateImageBase64 } from './prompts';
import { checkRateLimit, LIMITS } from './rate-limit';

/**
 * Receipt image caps: same size as chat, but includes PDF for document import.
 * Client-side allowlist: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']
 * (see ReceiptScannerModal.tsx validTypes).
 */
const RECEIPT_IMAGE_CAPS = {
  maxBytes: 10 * 1024 * 1024,
  mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'] as readonly string[],
};

const EXTRACTION_PROMPT = `You are an expert financial document parser. Analyze this image and extract ALL transaction/purchase information.

This could be:
- A physical receipt from a store
- An online order confirmation (Amazon, eBay, etc.)
- A food delivery order (DoorDash, Uber Eats, etc.)
- A bank/credit card statement
- An invoice or bill
- A payment confirmation screenshot
- A subscription charge notification

Extract and return a JSON object:
{
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "merchant": "Store/Company name (e.g., Amazon, Walmart, Starbucks)",
      "title": "Brief description of purchase",
      "amount": number (positive value, no currency symbols),
      "type": "expense" or "income",
      "category": "food|transportation|entertainment|shopping|healthcare|utilities|housing|insurance|subscriptions|travel|education|gifts|personal|pets|taxes|savings|income|other",
      "paymentMethod": "visa|mastercard|amex|discover|apple_pay|google_pay|cash|bank_transfer|paypal|chase|other",
      "lastFourDigits": "1234" (if visible on receipt/statement),
      "itemCount": number (how many items if visible),
      "tax": number (if visible),
      "tip": number (if visible),
      "subtotal": number (if visible),
      "orderNumber": "string" (if visible),
      "confidence": "high|medium|low"
    }
  ],
  "documentType": "receipt|invoice|bank_statement|order_confirmation|payment_notification|other",
  "merchant": "Primary merchant/store name",
  "totalAmount": number,
  "summary": "Brief description of what was parsed"
}

IMPORTANT:
- For Amazon orders, extract the order total and identify as "shopping"
- For food delivery, extract delivery fee, service fee, and food subtotal separately if visible
- For receipts with multiple items, create ONE transaction for the total unless it's clearly multiple separate purchases
- Always try to identify the payment method from card logos or text
- If you see last 4 digits of a card, include them
- Be precise with amounts - no rounding
- If date is unclear, use today's date
- If merchant is unclear, use the most prominent business name visible

If you cannot parse: { "transactions": [], "summary": "Could not parse image", "error": true }`;

/** Vision call + JSON extraction. */
async function callVision(apiKey: string, dataUrl: string) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Analyze this image and extract all transaction details. Return as JSON.',
            },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
          ],
        },
      ],
      max_tokens: 1500,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    console.error('openai error:', errorData);
    throw new HttpsError('internal', 'Failed to parse image');
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content || '';

  // Extract JSON from response (might be wrapped in markdown)
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return { success: true, parsed: JSON.parse(jsonMatch[0]), source: 'openai' };
    }
  } catch (parseError) {
    console.error('JSON parse error:', parseError);
  }

  return { success: true, parsed: { transactions: [], summary: content }, source: 'openai' };
}

export const parseReceipt = onCall(
  {
    secrets: ['OPENAI_API_KEY'],
    cors: true,
    // Base64 images are large; give vision calls room.
    memory: '512MiB',
    timeoutSeconds: 120,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in to scan receipts.');
    }
    await checkRateLimit(request.auth.uid, 'parseReceipt', LIMITS.parseReceipt);

    const { imageBase64, mimeType } = (request.data || {}) as {
      imageBase64?: string;
      mimeType?: string;
    };
    if (!imageBase64) {
      throw new HttpsError('invalid-argument', 'No file provided');
    }
    // Validate imageBase64 and mime type, preserving existing error message style for covered cases
    const mime = validateImageBase64(imageBase64, mimeType, RECEIPT_IMAGE_CAPS.mimeTypes, RECEIPT_IMAGE_CAPS.maxBytes);
    const dataUrl = `data:${mime};base64,${imageBase64}`;

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      throw new HttpsError('unavailable', 'AI service not configured');
    }
    return callVision(openaiKey, dataUrl);
  }
);
