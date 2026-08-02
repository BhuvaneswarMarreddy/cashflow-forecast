/**
 * @jest-environment node
 *
 * The diagnostic bundle exporter's refusals. The happy path is covered end-to-end by
 * the Playwright run (which produces the evidence the exporter consumes); these are
 * the guards that must hold even when someone points it somewhere dangerous.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts/diagnostics/export-trace.mjs');
const VALID_TRACE = 'a'.repeat(32);

function run(args: string[]): { status: number; output: string } {
  try {
    const output = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, output };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('export-trace refusals', () => {
  it('refuses to run without a trace id', () => {
    const { status, output } = run([]);
    expect(status).toBe(1);
    expect(output).toContain('Usage');
  });

  it('refuses a malformed trace id rather than guessing', () => {
    expect(run(['not-a-trace-id']).status).toBe(1);
    expect(run(['abc123']).status).toBe(1);
  });

  it('refuses an output path outside the repository', () => {
    const { status, output } = run([VALID_TRACE, '--out', '/tmp/obs-escape']);
    expect(status).toBe(1);
    expect(output).toContain('Refusing to write');
  });

  it('refuses to write into source directories', () => {
    for (const dir of ['src', 'e2e', 'scripts', 'docs']) {
      const { status, output } = run([VALID_TRACE, '--out', dir]);
      expect(status).toBe(1);
      expect(output).toContain('Refusing to write');
    }
  });

  it('refuses a dotfile output directory (never .git, .env, .firebase)', () => {
    expect(run([VALID_TRACE, '--out', '.firebase']).status).toBe(1);
    expect(run([VALID_TRACE, '--out', '.git']).status).toBe(1);
  });

  it('reports missing evidence instead of failing silently when nothing is found', () => {
    // No dev server, no Playwright evidence for this id: it must still produce a
    // manifest, and say plainly what is absent.
    const { status, output } = run([VALID_TRACE, '--out', 'diagnostic-bundles', '--base', 'http://127.0.0.1:9']);
    expect(status).toBe(0);
    expect(output).toContain('Missing evidence');
    expect(output).toMatch(/diagnostics endpoint unreachable|no Playwright evidence/);
    expect(output).toContain('Redaction: clean');
  });
});
