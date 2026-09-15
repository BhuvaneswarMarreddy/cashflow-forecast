/**
 * UI spec Phase A — system surfaces.
 *
 * The lies these pin: a mistyped URL showed Next's stock white 404 with the gold FAB
 * and tab bar still mounted over it; login offered "Sign up" twice and pitched
 * "Track expenses"; seven screens each drew their own loading block, one of them
 * white-on-gold and six of them silent to a screen reader.
 */
import React from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { render, screen } from '@testing-library/react';
import NotFound from '@/app/not-found';
import LoadingScreen from '@/components/LoadingScreen';
import { CHROME_ROUTES, NO_CHROME_ROUTES, showsChrome } from '@/components/ClientLayout';

const APP = join(process.cwd(), 'src/app');
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/** Every route that has a page.tsx, as a URL path. */
const appRoutes = (dir = APP): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return appRoutes(full);
    if (name !== 'page.tsx') return [];
    const route = relative(APP, dir).split(sep).join('/');
    return [route ? `/${route}` : '/'];
  });

describe('404 (A1)', () => {
  it('is the app’s own page: title, one sentence, one way home', () => {
    render(<NotFound />);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByText('That link does not exist in CashFlow.')).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent('Go home');
    expect(links[0]).toHaveAttribute('href', '/dashboard');
  });

  it('gets no FAB or tab bar: chrome is for real app screens only', () => {
    for (const path of ['/does-not-exist', '/accounts/nope', '/dashboard/typo']) {
      expect([path, showsChrome(path)]).toEqual([path, false]);
    }
    for (const path of ['/dashboard', '/forecast', '/history', '/flow', '/flow/review', '/accounts', '/settings']) {
      expect([path, showsChrome(path)]).toEqual([path, true]);
    }
    for (const path of ['/', '/login', '/signup', '/forgot-password', '/onboarding']) {
      expect([path, showsChrome(path)]).toEqual([path, false]);
    }
  });

  it('every page is a deliberate chrome decision, so a new screen cannot lose its tab bar silently', () => {
    const routes = appRoutes();
    const unsorted = routes.filter(
      (r) => !CHROME_ROUTES.includes(r) && !NO_CHROME_ROUTES.includes(r) && !r.startsWith('/dev/'),
    );
    expect(unsorted).toEqual([]);
    const stale = [...CHROME_ROUTES, ...NO_CHROME_ROUTES].filter((r) => !routes.includes(r));
    expect(stale).toEqual([]);
  });
});

describe('login copy (A4)', () => {
  const login = read('src/app/login/page.tsx');

  it('offers sign-up once, not twice', () => {
    expect(login).not.toContain('takes about a minute');
    expect(login.match(/href="\/signup"/g)).toHaveLength(1);
  });

  it('pitches the product question, not expense tracking', () => {
    expect(login).toContain('See where the money went, and what the next 90 days look like.');
    expect(login).not.toContain('Track expenses');
  });
});

describe('loading (A2)', () => {
  it('announces itself to assistive tech', () => {
    render(<LoadingScreen />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
  });

  it('is the only loading block in the app — no screen keeps its own copy', () => {
    const copies = appRoutes()
      .map((r) => `src/app${r === '/' ? '' : r}/page.tsx`)
      .filter((file) => read(file).includes('animate-pulse-glow'));
    expect(copies).toEqual([]);
  });

  it('never draws a white glyph on gold', () => {
    expect(read('src/components/LoadingScreen.tsx')).not.toContain('text-white');
  });
});
