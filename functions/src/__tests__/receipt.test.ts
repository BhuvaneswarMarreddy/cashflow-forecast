/**
 * Audit finding #3: when the model's reply carries no `{...}` substring at all
 * (a refusal or non-JSON prose), the try block is skipped, nothing throws, and
 * callVision fell through to `{ success: true, parsed: { transactions: [], summary } }`
 * with NO log at all — a silently empty "success" indistinguishable from a
 * genuinely empty receipt. A counts-only `{ matched }` log now runs before that
 * fallback return.
 */

import { callVision } from '../receipt';

function fetchResolving(content: string): Response {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as Response;
}

describe('callVision — extraction fallback logging', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs matched:false and keeps the returned shape when the reply has no {...} substring at all', async () => {
    const refusal = 'I cannot process this image.';
    jest.spyOn(global, 'fetch').mockResolvedValue(fetchResolving(refusal));
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await callVision('key', 'data:image/png;base64,abc');

    expect(result).toEqual({ success: true, parsed: { transactions: [], summary: refusal }, source: 'openai' });
    expect(logSpy).toHaveBeenCalledWith('parseReceipt', { matched: false });
  });

  it('logs matched:true (never the message text) when a {...} substring exists but fails to parse', async () => {
    const brokenJson = 'Sure, here it is: {"transactions": [oops]}';
    jest.spyOn(global, 'fetch').mockResolvedValue(fetchResolving(brokenJson));
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await callVision('key', 'data:image/png;base64,abc');

    expect(result).toEqual({
      success: true,
      parsed: { transactions: [], summary: brokenJson },
      source: 'openai',
    });
    expect(logSpy).toHaveBeenCalledWith('parseReceipt', { matched: true });
  });

  it('does not log the fallback line at all when the reply parses cleanly', async () => {
    const json = '{"transactions": [], "summary": "ok"}';
    jest.spyOn(global, 'fetch').mockResolvedValue(fetchResolving(json));
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await callVision('key', 'data:image/png;base64,abc');

    expect(result).toEqual({ success: true, parsed: { transactions: [], summary: 'ok' }, source: 'openai' });
    expect(logSpy).not.toHaveBeenCalled();
  });
});
