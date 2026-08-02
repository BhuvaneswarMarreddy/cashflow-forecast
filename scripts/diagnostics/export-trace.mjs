#!/usr/bin/env node
/**
 * Export every safe piece of evidence for one trace id into a diagnostic bundle.
 *
 *   npm run diag:export -- <traceId> [--out diagnostic-bundles] [--base http://127.0.0.1:3000]
 *
 * Sources, all local:
 *   - the development diagnostics endpoint  (GET /api/diagnostics/trace?traceId=)
 *   - Playwright evidence                   (test-results/observability/<traceId>/)
 *   - the Playwright trace + HTML report    (test-results/, playwright-report/)
 *
 * Everything written passes through the same redactor the application uses, and the
 * bundle is scanned for secrets before it is declared clean. Node stdlib only.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, resolve, basename, sep } from 'node:path';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Redaction — mirrors src/lib/obs/redact.ts. Kept dependency-free on purpose so
// the exporter runs without a build step; the rules are asserted in
// src/__tests__/obs-export-trace.test.ts to stay in step with the app's redactor.
// ---------------------------------------------------------------------------
const REDACTED = '[REDACTED]';
const SECRET_KEY = /^(authorization|cookie|set-?cookie|access-?url|simplefin.*|api-?key|.*token|.*secret|.*password|.*credential|connection-?string|dsn|ssn|session|email|address)$/i;
const MASK_KEY = /^(account-?number|card-?number|routing-?number|iban|pan|last-?four-?digits)$/i;
const VALUE_PATTERNS = [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@[^\s]+/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/\S+/gi,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b\d{3}-\d{2}-\d{4}\b/g,
];

const redactString = (s) => {
  let out = s;
  for (const re of VALUE_PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(/\b\d{12,19}\b/g, (m) => `****${m.slice(-4)}`);
  return out.replace(/([?&#][^=&\s]*(?:token|secret|password|key|access_?url|auth|session)[^=&\s]*)=([^&\s]+)/gi, `$1=${REDACTED}`);
};

function redact(value, depth = 0) {
  if (value == null || depth > 8) return value ?? null;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY.test(k)) out[k] = REDACTED;
    else if (MASK_KEY.test(k)) out[k] = typeof v === 'string' || typeof v === 'number' ? `****${String(v).replace(/\D/g, '').slice(-4)}` : REDACTED;
    else out[k] = redact(v, depth + 1);
  }
  return out;
}

const findSecrets = (text) => {
  const hits = [];
  for (const re of VALUE_PATTERNS) if (new RegExp(re.source, re.flags.replace('g', '')).test(text)) hits.push(re.source);
  if (/\b\d{12,19}\b/.test(text)) hits.push('long-digit-run');
  return hits;
};

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const traceId = argv.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

if (!traceId || !/^[0-9a-f]{32}$/.test(traceId)) {
  console.error('Usage: npm run diag:export -- <32-hex-traceId> [--out <dir>] [--base <url>]');
  process.exit(1);
}

const outRoot = resolve(flag('out', 'diagnostic-bundles'));
const baseUrl = flag('base', process.env.PW_BASE_URL || 'http://127.0.0.1:3000');
const repoRoot = process.cwd();

// Refuse to write outside the repository, into a dotfile directory, or over source.
const forbidden = [resolve(repoRoot, 'src'), resolve(repoRoot, 'e2e'), resolve(repoRoot, 'scripts'), resolve(repoRoot, 'docs')];
if (!outRoot.startsWith(repoRoot + sep) || forbidden.some((f) => outRoot === f || outRoot.startsWith(f + sep)) || basename(outRoot).startsWith('.')) {
  console.error(`Refusing to write a bundle to ${outRoot} — choose a path inside the repository and outside source directories.`);
  process.exit(1);
}

const bundleDir = join(outRoot, traceId);
mkdirSync(join(bundleDir, 'screenshots'), { recursive: true });
mkdirSync(join(bundleDir, 'playwright-trace'), { recursive: true });

const missing = [];
const artifacts = [];
const note = (relPath) => artifacts.push(relPath);

const write = (name, data) => {
  const text = typeof data === 'string' ? redactString(data) : JSON.stringify(redact(data), null, 2);
  writeFileSync(join(bundleDir, name), text.endsWith('\n') ? text : text + '\n');
  note(name);
};

const git = (cmd, fallback = 'unknown') => {
  try { return execSync(cmd, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return fallback; }
};

// ---------------------------------------------------------------------------
// 1. Backend + frontend events from the development diagnostics endpoint
// ---------------------------------------------------------------------------
let diagnostics = null;
try {
  const res = await fetch(`${baseUrl}/api/diagnostics/trace?traceId=${traceId}`, { signal: AbortSignal.timeout(5000) });
  if (res.ok) {
    const body = await res.json();
    if (body.found) diagnostics = body;
    else missing.push(`diagnostics endpoint has no events for ${traceId} (the dev server may have restarted — its trace store is in-memory)`);
  } else {
    missing.push(`diagnostics endpoint returned ${res.status} (it is disabled outside development/test)`);
  }
} catch (e) {
  missing.push(`diagnostics endpoint unreachable at ${baseUrl} (${e.name}) — start it with \`npm run dev\``);
}

if (diagnostics) {
  const events = diagnostics.events ?? [];
  write('trace-summary.json', { traceId, summary: diagnostics.summary, eventCount: diagnostics.eventCount, environment: diagnostics.environment });
  const jsonl = (rows) => rows.map((r) => JSON.stringify(redact(r))).join('\n') + '\n';
  writeFileSync(join(bundleDir, 'frontend-events.jsonl'), jsonl(events.filter((e) => e.component)));
  note('frontend-events.jsonl');
  writeFileSync(join(bundleDir, 'backend-events.jsonl'), jsonl(events.filter((e) => e.endpoint)));
  note('backend-events.jsonl');
  const provenance = (diagnostics.provenance ?? []).filter(Boolean);
  if (provenance.length) write('provenance.json', provenance);
  else missing.push('no provenance event in this trace');
} else {
  missing.push('trace-summary.json, frontend-events.jsonl, backend-events.jsonl');
}

// ---------------------------------------------------------------------------
// 2. Playwright evidence recorded by e2e/accounts-observability.spec.ts
// ---------------------------------------------------------------------------
const pwDir = join(repoRoot, 'test-results', 'observability', traceId);
if (existsSync(pwDir)) {
  for (const name of readdirSync(pwDir)) {
    const src = join(pwDir, name);
    if (statSync(src).isDirectory()) continue;
    if (name.endsWith('.png')) {
      copyFileSync(src, join(bundleDir, 'screenshots', name));
      note(`screenshots/${name}`);
    } else if (name.endsWith('.json') || name.endsWith('.jsonl') || name.endsWith('.txt')) {
      // Re-redact rather than trusting the producer.
      const raw = readFileSync(src, 'utf8');
      const cleaned = name.endsWith('.json')
        ? JSON.stringify(redact(JSON.parse(raw)), null, 2)
        : redactString(raw);
      const target = artifacts.includes(name) ? `playwright-${name}` : name;
      writeFileSync(join(bundleDir, target), cleaned.endsWith('\n') ? cleaned : cleaned + '\n');
      note(target);
    }
  }
} else {
  missing.push(`no Playwright evidence at test-results/observability/${traceId} — run \`npm run test:e2e\``);
}

// Playwright's own .zip traces are retained on failure only.
const traceZips = [];
const findTraces = (dir) => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) findTraces(p);
    else if (name === 'trace.zip') traceZips.push(p);
  }
};
findTraces(join(repoRoot, 'test-results'));
for (const zip of traceZips) {
  const target = join(bundleDir, 'playwright-trace', `${basename(join(zip, '..'))}-trace.zip`);
  copyFileSync(zip, target);
  note(`playwright-trace/${basename(target)}`);
}
if (!traceZips.length) missing.push('no Playwright trace.zip (traces are retained on failure/retry only — see playwright.config.ts)');

// ---------------------------------------------------------------------------
// 3. Manifest + secret scan
// ---------------------------------------------------------------------------
let secretHits = [];
for (const rel of artifacts) {
  if (rel.endsWith('.png') || rel.endsWith('.zip')) continue;
  const hits = findSecrets(readFileSync(join(bundleDir, rel), 'utf8'));
  if (hits.length) secretHits.push({ file: rel, patterns: hits });
}

const manifest = {
  application: 'cashflow-forecast',
  environment: diagnostics?.environment ?? 'unknown (endpoint unavailable)',
  gitCommit: git('git rev-parse HEAD'),
  gitBranch: git('git rev-parse --abbrev-ref HEAD'),
  runName: `obs-001-accounts-${traceId.slice(0, 8)}`,
  generatedAt: new Date().toISOString(),
  traceIds: [traceId],
  artifacts: artifacts.sort(),
  redaction: {
    applied: true,
    mechanism: 'scripts/diagnostics/export-trace.mjs (mirrors src/lib/obs/redact.ts)',
    status: secretHits.length ? 'FAILED — see secretFindings' : 'clean',
    secretFindings: secretHits,
  },
  knownMissingEvidence: missing,
  notes: [
    'Diagnostic evidence only. Contains no credentials, no full account numbers and no raw provider payloads.',
    'Screenshots come from the sanitized fixture route unless a developer ran Playwright against real data — never commit those.',
  ],
};

writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`\nDiagnostic bundle: ${bundleDir}`);
console.log(`  Trace ID:  ${traceId}`);
console.log(`  Artifacts: ${artifacts.length}`);
console.log(`  Redaction: ${manifest.redaction.status}`);
if (missing.length) {
  console.log('  Missing evidence:');
  for (const m of missing) console.log(`    - ${m}`);
}
if (secretHits.length) {
  console.error('\nREFUSING TO PASS: the bundle still matches secret patterns. Inspect manifest.json → redaction.secretFindings.');
  process.exit(2);
}
