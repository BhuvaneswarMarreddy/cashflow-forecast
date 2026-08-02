/**
 * The ONE redactor. Every diagnostic sink (event emit, the dev diagnostics endpoint,
 * the bundle exporter) runs its payload through `redact()` before it is stored,
 * printed or written to disk. Nothing else is allowed to serialise diagnostic data.
 */

export const REDACTED = '[REDACTED]';

/** Keys whose VALUE is always destroyed, matched case/format-insensitively. */
const SECRET_KEYS = new Set([
  'authorization', 'cookie', 'setcookie', 'accessurl', 'simplefinaccessurl',
  'apikey', 'token', 'accesstoken', 'idtoken', 'refreshtoken', 'bearer',
  'secret', 'clientsecret', 'password', 'passwd', 'pwd', 'credentials',
  'connectionstring', 'dsn', 'ssn', 'sessioncookie', 'privatekey', 'mfasecret',
  'email', 'address', 'accessurls', 'session',
]);

/** Keys whose value is an account-ish number: masked to the last 4 instead of destroyed. */
const MASK_KEYS = new Set([
  'accountnumber', 'cardnumber', 'routingnumber', 'iban', 'pan', 'lastfourdigits',
]);

/** Suffix match, so `simplefin_access_url` / `openaiApiKey` / `x-api-token` all hit. */
const SECRET_SUFFIXES = ['token', 'secret', 'password', 'apikey', 'accessurl', 'connectionstring'];

const norm = (key: string) => key.toLowerCase().replace(/[^a-z]/g, '');

function isSecretKey(key: string): boolean {
  const k = norm(key);
  return SECRET_KEYS.has(k) || SECRET_SUFFIXES.some((s) => k.endsWith(s));
}

/** `****1234` — the only account identifier shape allowed to leave this module. */
export function maskAccountNumber(value: string): string {
  const digits = String(value).replace(/\D/g, '');
  return digits.length >= 4 ? `****${digits.slice(-4)}` : REDACTED;
}

// Value-shaped secrets that arrive with an innocent key (a URL in a message, a
// connection string inside an exception). Ordered: most specific first.
const VALUE_PATTERNS: Array<[RegExp, string]> = [
  // URL carrying credentials, incl. SimpleFIN access URLs (https://user:token@host/...)
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@[^\s]+/gi, REDACTED],
  // Database connection strings with or without inline credentials
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/\S+/gi, REDACTED],
  [/\b(?:Server|Data Source|Host)=[^;]+;[^\n]*(?:Password|Pwd)=[^;\n]*/gi, REDACTED],
  // Authorization header values
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, REDACTED],
  // JWTs anywhere
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, REDACTED],
  // Firebase/Google API keys
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, REDACTED],
  // OpenAI-style keys
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED],
  // SSN
  [/\b\d{3}-\d{2}-\d{4}\b/g, REDACTED],
];

/** 12-19 consecutive digits reads as a card/account number → keep only the last 4. */
const LONG_DIGITS = /\b\d{12,19}\b/g;

export function redactString(input: string): string {
  let out = input;
  for (const [re, to] of VALUE_PATTERNS) out = out.replace(re, to);
  out = out.replace(LONG_DIGITS, (m) => `****${m.slice(-4)}`);
  // Query strings: ?access_url=…&token=… survive the patterns above, kill by key.
  out = out.replace(
    /([?&#][^=&\s]*(?:token|secret|password|key|access_?url|auth|session)[^=&\s]*)=([^&\s]+)/gi,
    `$1=${REDACTED}`
  );
  return out;
}

/**
 * Deep-redact any diagnostic value. Objects and arrays are rebuilt (never mutated),
 * cycles collapse to '[Circular]', and depth is bounded so a stray Firestore document
 * cannot walk the whole graph into a log line.
 */
export function redact<T>(value: T, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null) return value;
  if (depth > 8) return '[MaxDepth]';

  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[Circular]';
    seen.add(value as object);

    if (Array.isArray(value)) {
      // Bounded: a diagnostic array longer than this is a payload, not a signal.
      const capped = value.slice(0, 50).map((v) => redact(v, depth + 1, seen));
      return value.length > 50 ? [...capped, `[+${value.length - 50} more]`] : capped;
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k)) { out[k] = REDACTED; continue; }
      if (MASK_KEYS.has(norm(k))) { out[k] = typeof v === 'string' || typeof v === 'number' ? maskAccountNumber(String(v)) : REDACTED; continue; }
      const r = redact(v, depth + 1, seen);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return REDACTED;
}

/** Scan any serialisable blob for things that must never have got this far. Used by tests and the exporter. */
export function findSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const [re] of VALUE_PATTERNS) if (new RegExp(re.source, re.flags).test(text)) hits.push(re.source);
  if (LONG_DIGITS.test(text)) hits.push('long-digit-run');
  return hits;
}
