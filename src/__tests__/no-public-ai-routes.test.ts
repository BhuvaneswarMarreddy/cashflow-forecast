/**
 * SEC-001 regression guard.
 *
 * `/api/ai/decision` and `/api/parse-receipt` were unauthenticated Next.js route
 * handlers that called OpenAI/Azure with a server-side API key — anyone on the
 * internet could bill the owner's account. They are replaced by the authenticated
 * `aiDecision` / `parseReceipt` callables (functions/, codebase "api"), reached via
 * src/lib/callables.ts.
 *
 * This test fails if either route returns, or if any future route handler starts
 * talking to an LLM provider with a server-side key.
 */
import fs from 'fs';
import path from 'path';

const API_DIR = path.join(process.cwd(), 'src/app/api');

/** Every file under src/app/api (empty when the directory does not exist). */
function apiFiles(dir: string = API_DIR): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? apiFiles(full) : [full];
  });
}

describe('SEC-001: no public AI proxy routes', () => {
  it.each(['src/app/api/ai/decision', 'src/app/api/parse-receipt'])(
    '%s no longer exists',
    (route) => {
      expect(fs.existsSync(path.join(process.cwd(), route))).toBe(false);
    }
  );

  it('no route under src/app/api uses a server-side LLM provider key', () => {
    const offenders = apiFiles().filter((f) =>
      /OPENAI_API_KEY|AZURE_OPENAI_KEY|ANTHROPIC_API_KEY/.test(
        fs.readFileSync(f, 'utf8')
      )
    );
    expect(offenders).toEqual([]);
  });

  it('the AI client entrypoint is the authenticated callables module', () => {
    const callables = fs.readFileSync(
      path.join(process.cwd(), 'src/lib/callables.ts'),
      'utf8'
    );
    for (const fn of ['aiDecision', 'parseReceiptCallable', 'aiChat']) {
      expect(callables).toContain(`export async function ${fn}`);
    }
  });
});
