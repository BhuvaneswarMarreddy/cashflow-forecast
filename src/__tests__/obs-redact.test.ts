import { redact, redactString, maskAccountNumber, findSecrets, REDACTED } from '@/lib/obs/redact';
import { FIXTURE_RAW_SYNC_DOC } from '@/lib/obs/fixtures';

describe('redaction — keys', () => {
  it('destroys bearer tokens, cookies and authorization headers', () => {
    const out = redact({
      Authorization: 'Bearer abcdef1234567890',
      Cookie: 'session=abc; __Secure-x=y',
      'Set-Cookie': 'session=abc',
      accessToken: 'zzz',
    }) as Record<string, string>;
    expect(out.Authorization).toBe(REDACTED);
    expect(out.Cookie).toBe(REDACTED);
    expect(out['Set-Cookie']).toBe(REDACTED);
    expect(out.accessToken).toBe(REDACTED);
  });

  it('destroys SimpleFIN access URLs however the key is spelled', () => {
    for (const key of ['accessUrl', 'access_url', 'ACCESS-URL', 'simpleFinAccessUrl']) {
      const out = redact({ [key]: 'https://u:p@bridge.simplefin.org/simplefin' }) as Record<string, string>;
      expect(out[key]).toBe(REDACTED);
    }
  });

  it('destroys connection strings, passwords and api keys', () => {
    const out = redact({
      connectionString: 'postgres://u:p@host:5432/db',
      DATABASE_PASSWORD: 'hunter2',
      openaiApiKey: 'sk-abcdefghijklmnopqrst',
      mfaSecret: 'JBSWY3DPEHPK3PXP',
    }) as Record<string, string>;
    expect(Object.values(out)).toEqual([REDACTED, REDACTED, REDACTED, REDACTED]);
  });

  it('redacts nested and deeply nested sensitive fields', () => {
    const out = redact({
      safe: 'ok',
      level1: { level2: { level3: { token: 'secret-value', count: 3 } } },
      list: [{ password: 'p' }, { fine: 1 }],
    }) as any;
    expect(out.safe).toBe('ok');
    expect(out.level1.level2.level3.token).toBe(REDACTED);
    expect(out.level1.level2.level3.count).toBe(3);
    expect(out.list[0].password).toBe(REDACTED);
    expect(out.list[1].fine).toBe(1);
  });

  it('masks account and card numbers rather than destroying them', () => {
    const out = redact({ accountNumber: '4111111111111234', cardNumber: '4242424242424242', lastFourDigits: '4242' }) as Record<string, string>;
    expect(out.accountNumber).toBe('****1234');
    expect(out.cardNumber).toBe('****4242');
    expect(out.lastFourDigits).toBe('****4242');
  });

  it('never mutates the input', () => {
    const input = { token: 'abc', nested: { password: 'p' } };
    redact(input);
    expect(input.token).toBe('abc');
    expect(input.nested.password).toBe('p');
  });

  it('survives cycles and bounds depth', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
    expect((redact(cyclic) as any).self).toBe('[Circular]');
  });
});

describe('redaction — values with innocent keys', () => {
  it('redacts credentials embedded in a URL', () => {
    expect(redactString('failed GET https://user:tok3nvalue@bridge.simplefin.org/accounts')).toContain(REDACTED);
    expect(redactString('failed GET https://user:tok3nvalue@bridge.simplefin.org/accounts')).not.toContain('tok3nvalue');
  });

  it('redacts connection strings and JWTs found in exception messages', () => {
    const msg = 'connect failed: postgres://admin:pw@db:5432/app token eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM';
    const out = redactString(msg);
    expect(out).not.toContain('admin:pw');
    expect(out).not.toContain('eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM');
  });

  it('masks long digit runs anywhere in free text', () => {
    expect(redactString('account 4111111111111234 declined')).toBe('account ****1234 declined');
  });

  it('redacts sensitive query-string parameters', () => {
    const out = redactString('/api/x?access_url=https://a&id_token=abc&safe=1');
    expect(out).not.toContain('id_token=abc');
    expect(out).toContain('safe=1');
  });

  it('redacts Error objects to name + sanitized message', () => {
    const out = redact(new Error('bad token eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM')) as any;
    expect(out.name).toBe('Error');
    expect(out.message).not.toContain('eyJhbGciOi');
  });
});

describe('maskAccountNumber', () => {
  it('keeps only the last four digits', () => {
    expect(maskAccountNumber('4242424242424242')).toBe('****4242');
    expect(maskAccountNumber('4242')).toBe('****4242');
  });
  it('refuses to guess when there are not four digits', () => {
    expect(maskAccountNumber('12')).toBe(REDACTED);
  });
});

describe('a raw sync document cannot escape', () => {
  it('drops the access URL and the session token', () => {
    const serialized = JSON.stringify(redact(FIXTURE_RAW_SYNC_DOC));
    expect(serialized).not.toContain('fixturetoken');
    expect(serialized).not.toContain('fixture-session-token-value');
    expect(serialized).not.toContain('bridge.simplefin.test');
  });

  it('findSecrets flags a payload that still contains one', () => {
    expect(findSecrets('https://u:p@host/x').length).toBeGreaterThan(0);
    expect(findSecrets('nothing to see, 42 accounts')).toEqual([]);
  });
});
