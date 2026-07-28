/**
 * parseReceipt callable — port of src/app/api/parse-receipt/route.ts.
 *
 * Azure OpenAI GPT-4 Vision primary, OpenAI fallback.
 * Input: { imageBase64, mimeType } (client converts the file, no FormData).
 * Response shape matches the old route body: { success, parsed, source }.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { checkRateLimit, LIMITS } from './rate-limit';

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

/** Shared vision call + JSON extraction for both providers. */
async function callVision(
  url: string,
  headers: Record<string, string>,
  extraBody: Record<string, unknown>,
  imageUrl: Record<string, unknown>,
  source: 'azure' | 'openai'
) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      ...extraBody,
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Analyze this image and extract all transaction details. Return as JSON.',
            },
            { type: 'image_url', image_url: imageUrl },
          ],
        },
      ],
      max_tokens: 1500,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    console.error(`${source} error:`, errorData);
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
      return { success: true, parsed: JSON.parse(jsonMatch[0]), source };
    }
  } catch (parseError) {
    console.error('JSON parse error:', parseError);
  }

  return { success: true, parsed: { transactions: [], summary: content }, source };
}

export const parseReceipt = onCall(
  {
    secrets: [
      'AZURE_OPENAI_ENDPOINT',
      'AZURE_OPENAI_KEY',
      'AZURE_OPENAI_DEPLOYMENT',
      'OPENAI_API_KEY',
    ],
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
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      throw new HttpsError('invalid-argument', 'No file provided');
    }
    const mime = typeof mimeType === 'string' && mimeType ? mimeType : 'image/jpeg';
    const dataUrl = `data:${mime};base64,${imageBase64}`;

    const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const azureApiKey = process.env.AZURE_OPENAI_KEY;
    const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';

    if (!azureEndpoint || !azureApiKey) {
      // Fallback to OpenAI if Azure not configured
      const openaiKey = process.env.OPENAI_API_KEY;
      if (!openaiKey) {
        throw new HttpsError('unavailable', 'AI service not configured');
      }
      return callVision(
        'https://api.openai.com/v1/chat/completions',
        { Authorization: `Bearer ${openaiKey}` },
        { model: 'gpt-4o-mini' },
        { url: dataUrl, detail: 'high' },
        'openai'
      );
    }

    // Use Azure OpenAI
    const azureUrl = `${azureEndpoint}/openai/deployments/${azureDeployment}/chat/completions?api-version=2024-02-15-preview`;
    return callVision(azureUrl, { 'api-key': azureApiKey }, {}, { url: dataUrl }, 'azure');
  }
);
