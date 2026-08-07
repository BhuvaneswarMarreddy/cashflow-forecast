/**
 * Every /dev fixture route renders a REAL screen with authentication bypassed.
 * That is safe only because the route 404s outside development, and that gate
 * lives in one `if` per route with nothing checking it. UI-112 added a third
 * such route, so the gate gets a guard.
 *
 * The check is structural on purpose: it fails when someone adds a fourth
 * fixture route and forgets the guard, which is the realistic way this breaks.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const devDir = join(process.cwd(), 'src/app/dev');
const routes = existsSync(devDir)
  ? readdirSync(devDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : [];

describe('/dev fixture routes are unreachable in production', () => {
  test('there is at least one dev route to guard (the glob is not silently empty)', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  test.each(routes)('/dev/%s gates on the environment before rendering', (route) => {
    const page = readFileSync(join(devDir, route, 'page.tsx'), 'utf8');

    // A server component, so the check runs before any client bundle is sent.
    expect(page).not.toContain("'use client'");
    expect(page).toContain('notFound()');
    expect(page).toMatch(/env !== 'development' && env !== 'test'/);
  });
});
