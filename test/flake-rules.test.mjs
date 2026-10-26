/**
 * audit-tests rules: each flake risk is found on the line it is on, the
 * mechanical ones carry a correct rewrite, comments are ignored, and files
 * whose tests flaked in the history rank first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFlakeFixes, matchBracket, scanFlakeRisks, webFirstRewrite } from '../dist/utils/flake-rules.js';
import { rankFileRisks } from '../dist/tools/audit-tests.js';

const SPEC = `import { test, expect } from '@playwright/test';

test.describe('cart', () => {
  test('adds an item', async ({ page }) => {
    await page.goto('http://localhost:3000/shop');
    await page.waitForTimeout(2000);
    expect(await page.getByRole('button', { name: 'Buy (1)' }).isVisible()).toBe(true);
    expect(page.getByText('Added')).toBeVisible();
    page.getByRole('link', { name: 'Cart' }).click();
    await page.locator('div > ul > li:nth-child(2) > span').click({ force: true });
    await page.waitForLoadState('networkidle');
    // await page.waitForTimeout(500);
    /* page.waitForTimeout(1)
       expect(await x.isVisible()).toBe(true) */
    const items = await page.$$('.item');
    await new Promise((r) => setTimeout(r, 300));
  });

  test.only('checks out', async ({ page }) => {
    expect(await page.locator('#total').textContent()).toBe('$5');
    await expect(page.locator('#ok')).toBeVisible({ timeout: 0 });
    page.on('dialog', (d) => d.accept());
  });
});
`;

test('every rule fires on its line, and comments are skipped', () => {
  const findings = scanFlakeRisks('tests/cart.spec.ts', SPEC);
  const got = findings.map((f) => `${f.line}:${f.rule}`);
  assert.deepEqual(got, [
    '5:hardcoded-url',
    '6:hard-wait',
    '7:non-retrying-assertion',
    '8:missing-await',
    '9:missing-await',
    '10:force-action',
    '10:fragile-selector',
    '11:networkidle',
    '15:element-handle',
    '16:sleep',
    '19:focused-test',
    '20:non-retrying-assertion',
    '21:no-timeout',
  ]);
  const byLine = Object.fromEntries(findings.map((f) => [`${f.line}:${f.rule}`, f]));
  assert.equal(byLine['6:hard-wait'].test, 'adds an item');
  assert.equal(byLine['20:non-retrying-assertion'].test, 'checks out');
  assert.equal(byLine['7:non-retrying-assertion'].fix, "    await expect(page.getByRole('button', { name: 'Buy (1)' })).toBeVisible();");
  assert.equal(byLine['8:missing-await'].fix, "    await expect(page.getByText('Added')).toBeVisible();");
  assert.equal(byLine['9:missing-await'].fix, "    await page.getByRole('link', { name: 'Cart' }).click();");
  assert.equal(byLine['19:focused-test'].fix, "  test('checks out', async ({ page }) => {");
  assert.equal(byLine['20:non-retrying-assertion'].fix, "    await expect(page.locator('#total')).toHaveText('$5');");
  assert.equal(byLine['6:hard-wait'].fix, undefined, 'a hard wait needs a judgement call');
});

test('webFirstRewrite covers the one-shot forms and leaves others alone', () => {
  const cases = [
    ['expect(await row.isHidden()).toBeTruthy();', 'await expect(row).toBeHidden();'],
    ['expect(await box.isChecked()).toBe(false);', 'await expect(box).not.toBeChecked();'],
    ['expect(await btn.isEnabled()).not.toBe(true);', 'await expect(btn).not.toBeEnabled();'],
    ['expect(await input.inputValue()).toEqual("Ann");', 'await expect(input).toHaveValue("Ann");'],
    ['expect(await rows.count()).toBe(3);', 'await expect(rows).toHaveCount(3);'],
    ["expect(await a.getAttribute('href')).toBe('/x');", "await expect(a).toHaveAttribute('href', '/x');"],
    ["expect(await page.title()).toBe('Shop');", "await expect(page).toHaveTitle('Shop');"],
    ["expect(page.url()).toBe('http://x.test/a');", "await expect(page).toHaveURL('http://x.test/a');"],
    ["expect(await el.innerText()).toContain('Hi (1)');", "await expect(el).toContainText('Hi (1)');"],
    ['await expect(await el.isVisible()).toBe(true);', 'await expect(el).toBeVisible();'],
  ];
  for (const [before, after] of cases) assert.equal(webFirstRewrite(before), after, before);
  assert.equal(webFirstRewrite('expect(await el.isVisible()).toBe(maybe);'), undefined);
  assert.equal(webFirstRewrite("expect(await page.title()).toContain('Shop');"), undefined);
  assert.equal(webFirstRewrite('expect(value).toBe(1);'), undefined);
});

test('matchBracket skips brackets inside strings', () => {
  const text = "f('a)', [1, ')'], { b: \"(\" })";
  assert.equal(matchBracket(text, 1), text.length - 1);
  assert.equal(matchBracket('f(', 1), -1);
});

test('applyFlakeFixes rewrites only lines that still match', () => {
  const findings = scanFlakeRisks('a.spec.ts', SPEC);
  const { source, applied } = applyFlakeFixes(SPEC, findings);
  assert.equal(applied.length, 5);
  const again = scanFlakeRisks('a.spec.ts', source).filter((f) => f.fix !== undefined);
  assert.equal(again.length, 0, 'a fixed file has nothing mechanical left');
  // A stale finding (line changed since the scan) is skipped.
  const stale = applyFlakeFixes(SPEC.replace("toBe('$5')", "toBe('$6')"), findings);
  assert.equal(stale.applied.length, 4);
  // CRLF files stay CRLF.
  assert.ok(applyFlakeFixes(SPEC.replace(/\n/g, '\r\n'), findings).source.includes('\r\n'));
});

test('files whose tests flaked in the history rank first', () => {
  const findings = [
    ...scanFlakeRisks('tests/a.spec.ts', "test('a', async ({ page }) => {\n  await page.waitForTimeout(1);\n});"),
    ...scanFlakeRisks('tests/b.spec.ts', "test('b', async ({ page }) => {\n  await page.waitForTimeout(1);\n  await page.click('x', { force: true });\n});"),
  ];
  const stats = [
    { key: 'a', file: 'a.spec.ts', title: 'a', runs: 10, passed: 6, failed: 1, flaky: 3, flips: 5, failRate: 0.4, flipRate: 0.55, strip: '', lastStatus: 'passed', lastAt: '' },
  ];
  const ranked = rankFileRisks(findings, stats);
  assert.deepEqual(ranked.map((r) => r.file), ['tests/a.spec.ts', 'tests/b.spec.ts']);
  assert.equal(ranked[0].unstable.length, 1);
  assert.equal(rankFileRisks(findings, [])[0].file, 'tests/b.spec.ts', 'without history, more findings rank first');
});
