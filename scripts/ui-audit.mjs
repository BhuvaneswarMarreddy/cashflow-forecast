#!/usr/bin/env node
/**
 * Measures the rendered UI instead of looking at it.
 *
 * Every defect this catches was already on screen and had been missed by
 * reading source and eyeballing screenshots — a `$` sitting on top of the value
 * in 36 inputs, corners that silently went square, targets under the thumb
 * minimum. Source review cannot see any of it, because all three are decided by
 * the cascade at paint time. So this walks the real pages, in a real browser,
 * at both widths and both themes, and reports coordinates.
 *
 * Usage:
 *   npx next dev -p 3111
 *   node scripts/ui-audit.mjs                # every target
 *   node scripts/ui-audit.mjs accounts       # targets matching a substring
 *   node scripts/ui-audit.mjs --json out.json
 */
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.AUDIT_BASE || 'http://localhost:3111';

/**
 * Each target is one auditable surface. `steps` are clicks that reveal an
 * in-page tab — a tab is a distinct surface even though it shares a URL, and
 * auditing only the default tab is how the Budget tab shipped broken.
 */
const TARGETS = [
  { name: 'home', url: '/dev/home-fixture' },
  { name: 'bills', url: '/dev/bills-fixture' },
  { name: 'accounts:accounts', url: '/dev/accounts-fixture' },
  { name: 'accounts:bills-subs', url: '/dev/accounts-fixture', steps: ['Bills & Subs'] },
  { name: 'accounts:budget', url: '/dev/accounts-fixture', steps: ['Budget'] },
  { name: 'accounts:debt', url: '/dev/accounts-fixture', steps: ['Debt'] },
  { name: 'forecast:timeline', url: '/dev/forecast-fixture' },
  { name: 'forecast:cashflow', url: '/dev/forecast-fixture', steps: ['Cashflow'] },
  { name: 'activity:transactions', url: '/dev/activity-fixture' },
  { name: 'activity:insights', url: '/dev/activity-fixture', steps: ['Insights'] },
  { name: 'activity:runway', url: '/dev/activity-fixture', steps: ['Runway'] },
  { name: 'flow', url: '/dev/flow-fixture' },
  { name: 'login', url: '/login' },
  { name: 'signup', url: '/signup' },
  { name: 'forgot-password', url: '/forgot-password' },
];

const VIEWPORTS = [
  { label: '390', width: 390, height: 844 },
  { label: '1280', width: 1280, height: 900 },
];
const THEMES = ['dark', 'light'];

/** The shape contract from globals.css @theme. 0 and 50% are legitimate too. */
const ALLOWED_RADII = [0, 10, 16, 999];
const TOUCH_MIN = 44;

/**
 * The spec's spacing scale is a 4px grid (edges 16/32, card padding 16/20, gaps
 * 12/24), so the rule is the grid itself rather than a hand-listed set — an
 * explicit list flagged legitimate layout offsets like the 96px navbar clearance
 * while missing that 36px is on-grid. 1px and 2px are hairlines and separators.
 */
const SPACING_EXTRA = [1, 2];

/* ------------------------------------------------------------------ *
 * Everything below runs INSIDE the page.
 * ------------------------------------------------------------------ */
function collectFindings({ ALLOWED_RADII, TOUCH_MIN, SPACING_EXTRA }) {
  const findings = [];
  const add = (check, detail, el, extra = {}) =>
    findings.push({ check, detail, selector: describe(el), ...extra });

  function describe(el) {
    if (!el) return '(none)';
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
      : '';
    const text = (el.textContent || '').trim().slice(0, 40);
    return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ''}`;
  }

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };

  /* --- 1. An input's own content box is covered by something ------- *
   * The `$` prefix bug: the icon is positioned into the input's text
   * area because the padding meant to clear it never applied.          */
  for (const field of document.querySelectorAll('input, textarea, select')) {
    if (!visible(field)) continue;
    const r = field.getBoundingClientRect();
    const cs = getComputedStyle(field);
    const content = {
      left: r.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth),
      right: r.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth),
      top: r.top + parseFloat(cs.paddingTop),
      bottom: r.bottom - parseFloat(cs.paddingBottom),
    };
    const host = field.closest('.relative, [style*="position"]') || field.parentElement;
    if (!host) continue;
    for (const sib of host.querySelectorAll('svg, span, i, div')) {
      if (sib === field || sib.contains(field) || field.contains(sib)) continue;
      if (!visible(sib)) continue;
      const sp = getComputedStyle(sib).position;
      if (sp !== 'absolute' && sp !== 'fixed') continue;
      const b = sib.getBoundingClientRect();
      const overlapX = Math.min(b.right, content.right) - Math.max(b.left, content.left);
      const overlapY = Math.min(b.bottom, content.bottom) - Math.max(b.top, content.top);
      if (overlapX > 1 && overlapY > 1) {
        add(
          'input-overlap',
          `${describe(sib)} covers ${Math.round(overlapX)}px of the field's text area`,
          field,
          { overlapPx: Math.round(overlapX) }
        );
      }
    }
  }

  /* --- 2. Something is painted over readable text ------------------ */
  const textLeaves = [...document.querySelectorAll('body *')].filter((el) => {
    if (el.children.length > 0) return false;
    // .sr-only is clipped to 1px on purpose — it is meant to be unreadable by
    // eye and read by a screen reader, so "something covers it" is not a defect.
    if (el.closest('.sr-only, [aria-hidden="true"]')) return false;
    const t = (el.textContent || '').trim();
    return t.length > 1 && visible(el);
  });
  for (const el of textLeaves) {
    const r = el.getBoundingClientRect();
    // elementFromPoint only answers for points inside the viewport. Clamping an
    // off-screen element's sample point into range makes every row below the
    // fold report as "covered by" whatever happens to sit at the clamp — which
    // was ~80% of this check's output before it was fixed.
    if (r.top < 0 || r.left < 0) continue;
    if (r.bottom > window.innerHeight || r.right > window.innerWidth) continue;
    const x = r.left + 4;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit) continue;
    if (hit.closest('nextjs-portal, [data-nextjs-toast]')) continue; // dev overlay
    if (hit === el || hit.contains(el) || el.contains(hit)) continue;
    if (getComputedStyle(hit).pointerEvents === 'none') continue;
    // Fixed/sticky chrome (nav bars, the FAB) sits over whatever is scrolled
    // under it by design. Reporting that as an overlap buries the real ones, so
    // it gets its own lower-priority check.
    const fixedAncestor = (() => {
      for (let n = hit; n && n !== document.body; n = n.parentElement) {
        const p = getComputedStyle(n).position;
        if (p === 'fixed' || p === 'sticky') return n;
      }
      return null;
    })();
    if (fixedAncestor) {
      add('under-fixed-chrome', `sits under ${describe(fixedAncestor)}`, el);
      continue;
    }
    add('text-covered', `covered by ${describe(hit)}`, el);
  }

  /* --- 3. Touch targets under the thumb minimum -------------------- */
  for (const el of document.querySelectorAll('button, a[href], input, select, [role="button"], [role="tab"]')) {
    if (!visible(el)) continue;
    if (el.closest('nextjs-portal, [data-nextjs-toast]')) continue; // dev overlay
    // A TEXT link is a reading target, not a control, and WCAG 2.5.8 exempts it
    // for that reason. Holding one to 44px means padding out every link in the
    // app — which is exactly what the blanket `a { min-height: 44px }` rule did
    // before it was removed for stretching inline links as flex children.
    //
    // The exemption is deliberately narrow, and matches the CSS rule that ships:
    // navigation links and anchors styled as buttons ARE controls and still
    // have to earn 44px. Icon-only anchors are never exempt.
    const isTextLink =
      el.tagName === 'A' &&
      (el.textContent || '').trim().length > 0 &&
      el.getAttribute('role') !== 'button' &&
      !el.closest('nav') &&
      !el.className.toString().includes('btn-');
    if (isTextLink) continue;
    const r = el.getBoundingClientRect();

    // An absolutely-positioned ::before/::after is a real, clickable hit area
    // that getBoundingClientRect does not report. Ignoring it would flag the
    // .tap-target pattern — a 24px icon carrying a 44px pseudo-element — as a
    // failure, and push the fix back toward padding, which is what broke the
    // layouts in the first place.
    let w = r.width;
    let h = r.height;
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content === 'none' || ps.position !== 'absolute') continue;
      const pw = parseFloat(ps.width);
      const ph = parseFloat(ps.height);
      if (Number.isFinite(pw)) w = Math.max(w, pw);
      if (Number.isFinite(ph)) h = Math.max(h, ph);
    }

    if (h < TOUCH_MIN || w < TOUCH_MIN) {
      add('small-target', `${Math.round(w)}×${Math.round(h)} (min ${TOUCH_MIN})`, el);
    }
  }

  /* --- 4. Radii off the three-step scale --------------------------- */
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    if (el.closest('nextjs-portal, [data-nextjs-toast]')) continue; // dev overlay
    const cs = getComputedStyle(el);
    for (const corner of ['borderTopLeftRadius', 'borderTopRightRadius']) {
      const raw = cs[corner];
      if (!raw || raw === '0px' || raw.includes('%')) continue;
      const px = Math.round(parseFloat(raw));
      // Tailwind's rounded-full is calc(infinity * 1px); anything past the pill
      // step renders identically to it.
      if (px >= 999) continue;
      if (!ALLOWED_RADII.includes(px) && px > 0) {
        add('off-scale-radius', `${px}px is not one of ${ALLOWED_RADII.join('/')}`, el, { px });
        break;
      }
    }
  }

  /* --- 5. Text that cannot be read at this size -------------------- */
  for (const el of textLeaves) {
    const cs = getComputedStyle(el);
    if (cs.overflow !== 'visible' || cs.textOverflow === 'ellipsis') continue;
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      add('text-clipped', `${el.scrollWidth}px of text in ${el.clientWidth}px`, el);
    }
  }

  /* --- 6. Spacing off the 4px scale -------------------------------- *
   * A value someone typed rather than chose. Reported per element AND
   * summarised as a value histogram, because "the app uses 19 distinct
   * paddings" is the finding, not any single one of them.               */
  const spacingSeen = {};
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    if (el.closest('nextjs-portal, [data-nextjs-toast], svg')) continue;
    const cs = getComputedStyle(el);
    const props = {
      paddingTop: cs.paddingTop, paddingRight: cs.paddingRight,
      paddingBottom: cs.paddingBottom, paddingLeft: cs.paddingLeft,
      rowGap: cs.rowGap, columnGap: cs.columnGap,
      marginTop: cs.marginTop, marginBottom: cs.marginBottom,
    };
    const bad = [];
    for (const [prop, raw] of Object.entries(props)) {
      if (!raw || raw === 'normal' || raw.includes('%')) continue;
      const px = Math.round(parseFloat(raw));
      if (!Number.isFinite(px) || px < 0) continue; // negative margins are deliberate
      (spacingSeen[prop.startsWith('margin') ? 'margin' : prop.startsWith('padding') ? 'padding' : 'gap'] ??= {});
      const bucket = spacingSeen[prop.startsWith('margin') ? 'margin' : prop.startsWith('padding') ? 'padding' : 'gap'];
      bucket[px] = (bucket[px] || 0) + 1;
      const onGrid = px % 4 === 0 || SPACING_EXTRA.includes(px);
      if (!onGrid) bad.push(`${prop}:${px}px`);
    }
    if (bad.length) add('off-scale-spacing', bad.join(' '), el, { values: bad });
  }
  findings.push({ check: 'spacing-histogram', detail: JSON.stringify(spacingSeen), selector: '(page)' });

  /* --- 7. Sibling rows in one list disagree on rhythm --------------- *
   * The eye reads a list as broken long before it can name why: two rows
   * 12px apart and the next 20px. Only flagged for lists of 3+.        */
  for (const list of document.querySelectorAll('ul, ol, [role="list"], .space-y-2, .space-y-3, .space-y-4')) {
    const kids = [...list.children].filter(visible);
    if (kids.length < 3) continue;
    const heights = kids.map((k) => {
      const cs = getComputedStyle(k);
      return `${Math.round(parseFloat(cs.paddingTop))}/${Math.round(parseFloat(cs.paddingBottom))}`;
    });
    const distinct = new Set(heights);
    if (distinct.size > 1) {
      add('ragged-list-rhythm', `${distinct.size} different row paddings: ${[...distinct].join(', ')}`, list);
    }
  }

  /* --- 8. The page scrolls sideways -------------------------------- */
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) {
    const wide = [...document.querySelectorAll('body *')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.right > doc.clientWidth + 1 && visible(el);
    });
    add(
      'horizontal-overflow',
      `page is ${doc.scrollWidth}px wide in ${doc.clientWidth}px; widest: ${describe(wide[0])}`,
      doc
    );
  }

  return findings;
}

/* ------------------------------------------------------------------ *
 * Driver
 * ------------------------------------------------------------------ */
const argv = process.argv.slice(2);
const jsonFlag = process.argv.indexOf('--json');
const jsonPath = jsonFlag > -1 ? process.argv[jsonFlag + 1] : null;
// Skip the flag's own value, or `--json out.json` gets read as a target filter
// and silently audits nothing.
const filter = argv.find((a) => !a.startsWith('--') && a !== jsonPath);
const targets = filter ? TARGETS.filter((t) => t.name.includes(filter)) : TARGETS;

const browser = await chromium.launch();
const all = [];

for (const target of targets) {
  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        colorScheme: theme,
      });
      const page = await ctx.newPage();
      let surface = `${target.name} · ${theme} · ${vp.label}`;
      try {
        // NOT networkidle: a fixture user id makes screens that call Firestore
        // directly retry forever, so the network never goes idle and the whole
        // surface times out — and a timed-out surface reports zero findings,
        // which reads as "clean". Load, then settle on a fixed budget.
        await page.goto(`${BASE}${target.url}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2500);
        for (const step of target.steps || []) {
          await page.getByRole('button', { name: step }).first().click({ timeout: 10000 });
          await page.waitForTimeout(800);
        }
        await page.waitForTimeout(600);
        const rendered = await page.evaluate(() => document.body.innerText.trim().length);
        if (rendered < 40) {
          throw new Error(`surface rendered only ${rendered} chars — nothing to audit`);
        }
        const findings = await page.evaluate(collectFindings, { ALLOWED_RADII, TOUCH_MIN, SPACING_EXTRA });
        for (const f of findings) all.push({ surface, ...f });
        console.log(`${findings.length ? '✗' : '✓'} ${surface.padEnd(34)} ${findings.length} finding(s)`);
      } catch (err) {
        console.log(`! ${surface.padEnd(34)} ${err.message.split('\n')[0]}`);
        all.push({ surface, check: 'audit-error', detail: err.message.split('\n')[0], selector: '-' });
      }
      await ctx.close();
    }
  }
}
await browser.close();

/* Group by check, then by the defect itself — the same broken component on four
   surfaces is one thing to fix, not four. */
const byCheck = {};
for (const f of all) (byCheck[f.check] ||= []).push(f);

console.log('\n' + '='.repeat(72));
console.log('SUMMARY');
console.log('='.repeat(72));
for (const [check, items] of Object.entries(byCheck).sort((a, b) => b[1].length - a[1].length)) {
  const distinct = new Set(items.map((i) => i.selector));
  console.log(`\n${check}: ${items.length} occurrence(s), ${distinct.size} distinct element(s)`);
  for (const sel of [...distinct].slice(0, 8)) {
    const example = items.find((i) => i.selector === sel);
    const surfaces = new Set(items.filter((i) => i.selector === sel).map((i) => i.surface.split(' · ')[0]));
    console.log(`  • ${sel}`);
    console.log(`      ${example.detail}`);
    console.log(`      on: ${[...surfaces].join(', ')}`);
  }
  if (distinct.size > 8) console.log(`  … and ${distinct.size - 8} more`);
}
console.log(`\nTOTAL: ${all.length} findings across ${targets.length} targets × ${THEMES.length} themes × ${VIEWPORTS.length} widths`);

// A surface that failed to load contributes no findings, which reads exactly
// like a clean surface. Say so loudly, and exit non-zero, or the audit quietly
// reports the screens it never saw as the healthiest ones.
const failed = [...new Set(all.filter((f) => f.check === 'audit-error').map((f) => f.surface.split(' · ')[0]))];
if (failed.length) {
  console.log(`\n⚠ ${failed.length} surface(s) COULD NOT BE AUDITED — their zero counts mean nothing:`);
  for (const s of failed) console.log(`    ${s}`);
  process.exitCode = 1;
}

if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify(all, null, 2));
  console.log(`\nwrote ${jsonPath}`);
}
