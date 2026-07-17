/**
 * Receipt/Screenshot Parser API
 * 
 * Uses Azure OpenAI GPT-4 Vision to extract transaction data from images
 * Supports: receipts, invoices, online order screenshots, bank statements
 */

import { NextRequest, NextResponse } from 'next/server';

const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_API_KEY = process.env.AZURE_OPENAI_KEY;
const AZURE_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';

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

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Convert file to base64
    const bytes = await file.arrayBuffer();
    const base64 = Buffer.from(bytes).toString('base64');
    const mimeType = file.type || 'image/jpeg';

    // Check if Azure is configured
    if (!AZURE_ENDPOINT || !AZURE_API_KEY) {
      // Fallback to OpenAI if Azure not configured
      const openaiKey = process.env.OPENAI_API_KEY;
      if (!openaiKey) {
        return NextResponse.json({ 
          error: 'AI service not configured',
          parsed: null 
        }, { status: 503 });
      }

      // Use OpenAI GPT-4 Vision
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: EXTRACTION_PROMPT
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Analyze this image and extract all transaction details. Return as JSON.'
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mimeType};base64,${base64}`,
                    detail: 'high'
                  }
                }
              ]
            }
          ],
          max_tokens: 1500,
          temperature: 0.1,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('OpenAI error:', errorData);
        return NextResponse.json({ 
          error: 'Failed to parse image',
          details: errorData 
        }, { status: 500 });
      }

      const data = await response.json();
      const content = data.choices[0]?.message?.content || '';
      
      // Parse JSON from response
      try {
        // Extract JSON from response (might be wrapped in markdown)
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return NextResponse.json({ 
            success: true, 
            parsed,
            source: 'openai'
          });
        }
      } catch (parseError) {
        console.error('JSON parse error:', parseError);
      }

      return NextResponse.json({ 
        success: true, 
        parsed: { transactions: [], summary: content },
        source: 'openai'
      });
    }

    // Use Azure OpenAI
    const azureUrl = `${AZURE_ENDPOINT}/openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=2024-02-15-preview`;
    
    const response = await fetch(azureUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_API_KEY,
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: EXTRACTION_PROMPT
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Analyze this image and extract all transaction details. Return as JSON.'
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64}`
                }
              }
            ]
          }
        ],
        max_tokens: 1500,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Azure error:', errorData);
      return NextResponse.json({ 
        error: 'Failed to parse image',
        details: errorData 
      }, { status: 500 });
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content || '';
    
    // Parse JSON from response
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return NextResponse.json({ 
          success: true, 
          parsed,
          source: 'azure'
        });
      }
    } catch (parseError) {
      console.error('JSON parse error:', parseError);
    }

    return NextResponse.json({ 
      success: true, 
      parsed: { transactions: [], summary: content },
      source: 'azure'
    });

  } catch (error: any) {
    console.error('Parse receipt error:', error);
    return NextResponse.json({ 
      error: 'Failed to process request',
      details: error?.message 
    }, { status: 500 });
  }
}

