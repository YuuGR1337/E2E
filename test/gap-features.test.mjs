/**
 * The 0.7.0 features: TOTP codes for logins (RFC 6238 vectors), the heal
 * guard's rules, the quarantine list and how runs and ci treat it, and
 * which environment variables a login may read.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { base32Decode, generateTotp, parseTotpSecret, totpSecondsLeft } from '../dist/utils/totp.js';
import { guardFileChange, guardVerdict, isGuardedFile, maskCode, renderGuardReport, shapeOf } from '../dist/utils/test-change-guard.js';
import { addDays, isExpired, matchesEntry, readQuarantine, splitFailures, writeQuarantine } from '../dist/utils/quarantine.js';
import { loginEnvAllowed, resolveLoginValues } from '../dist/tools/save-login.js';
import { assertGitRef, checkTestChangeTool, guardAgainstRef } from '../dist/tools/check-test-change.js';
import { quarantineTool } from '../dist/tools/quarantine.js';
import { passesWithQuarantine, renderRunResult } from '../dist/tools/run-test.js';
import { createToolStore } from '../dist/tools/shared.js';
import { PROBE_SCRIPT } from '../dist/tools/probe-script.js';

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } };
const ctxFor = (root) => ({ logger: silent, store: createToolStore(), projectRoot: root });
const textOf = (response) => response.content.map((c) => c.text).join('\n');

/* ---------------- TOTP ---------------- */

// RFC 6238 appendix B: the ASCII key "12345678901234567890" (SHA1) at fixed times, 8 digits.
const RFC_KEY = Buffer.from('12345678901234567890');
const RFC = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

test('generateTotp matches the RFC 6238 SHA1 vectors', () => {
  for (const [seconds, code] of RFC) {
    assert.equal(generateTotp({ key: RFC_KEY, digits: 8, period: 30, algorithm: 'SHA1' }, seconds * 1000), code);
  }
});

test('the browser child computes the same codes as the server', () => {
  const source = PROBE_SCRIPT.slice(PROBE_SCRIPT.indexOf('function totpCode'), PROBE_SCRIPT.indexOf('async function fillValue'));
  const load = (name) => {
    if (name === 'node:crypto') return crypto;
    throw new Error(`unexpected require ${name}`);
  };
  const totpCode = new Function('require', `${source}; return totpCode;`)(load);
  for (const [seconds, code] of RFC) {
    assert.equal(totpCode({ key: RFC_KEY.toString('hex'), digits: 8, period: 30, algorithm: 'SHA1' }, seconds * 1000), code);
  }
});

test('parseTotpSecret reads base32 and otpauth URIs', () => {
  assert.deepEqual(base32Decode('GEZDGNBVGY3TQOJQ'), Buffer.from('1234567890'));
  assert.deepEqual(base32Decode('gezd gnbv-gy3t qojq===='), Buffer.from('1234567890'));
  const uri = parseTotpSecret('otpauth://totp/Shop:ann?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&period=60&algorithm=SHA256&issuer=Shop');
  assert.equal(uri.digits, 8);
  assert.equal(uri.period, 60);
  assert.equal(uri.algorithm, 'SHA256');
  assert.throws(() => parseTotpSecret('not base32!'), /not base32/);
  assert.throws(() => parseTotpSecret('otpauth://hotp/x?secret=GEZDGNBV&counter=1'), /time-based/);
  const plain = parseTotpSecret('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(generateTotp(plain, 59_000), '287082');
  assert.equal(totpSecondsLeft(plain, 59_000), 1);
});

test('logins may read only test-looking variables, and missing ones are named', () => {
  assert.equal(loginEnvAllowed('E2E_PASSWORD'), true);
  assert.equal(loginEnvAllowed('TEST_USER'), true);
  assert.equal(loginEnvAllowed('AWS_SECRET_ACCESS_KEY'), false);
  assert.equal(loginEnvAllowed('PW_MCP_HTTP_TOKEN'), false);
  assert.equal(loginEnvAllowed('GITHUB_TOKEN'), false);
  process.env.PW_MCP_LOGIN_ENV = 'SHOP_PASS';
  assert.equal(loginEnvAllowed('SHOP_PASS'), true);
  delete process.env.PW_MCP_LOGIN_ENV;

  process.env.E2E_PW_TEST_A = 'secret-a';
  const values = resolveLoginValues([
    { type: 'fill', locator: "getByLabel('Password')", value: '{{env:E2E_PW_TEST_A}}' },
    { type: 'click', locator: "getByRole('button')" },
  ]);
  assert.deepEqual(values, { E2E_PW_TEST_A: 'secret-a' });
  assert.throws(() => resolveLoginValues([{ type: 'fill', locator: 'x', value: '{{env:HOME}}' }]), /not an allowed login variable/);
  assert.throws(() => resolveLoginValues([{ type: 'fill', locator: 'x', value: '{{env:E2E_NOT_SET_ANYWHERE}}' }]), /E2E_NOT_SET_ANYWHERE/);
  delete process.env.E2E_PW_TEST_A;
});

/* ---------------- heal guard ---------------- */

const BEFORE = `import { test, expect } from '@playwright/test';

test.describe('cart', () => {
  test('adds an item', async ({ page }) => {
    await page.goto('/shop');
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByTestId('count')).toHaveText('1');
    await expect(page.getByRole('status')).toBeVisible();
  });

  test('removes an item', async ({ page }) => {
    await page.goto('/cart');
    await expect(page.getByText('Empty')).toBeVisible();
  });
});

// test('commented out', () => { expect(1).toBe(1) })
const note = "test('not a test', () => {})";
`;

test('maskCode hides strings and comments but keeps positions', () => {
  const masked = maskCode(BEFORE);
  assert.equal(masked.length, BEFORE.length);
  assert.equal(masked.split('\n').length, BEFORE.split('\n').length);
  assert.ok(!masked.includes('commented out'));
  assert.ok(!masked.includes('not a test'));
});

test('shapeOf finds tests by describe path and counts their assertions', () => {
  const shape = shapeOf(BEFORE);
  assert.deepEqual([...shape.tests.keys()], ['cart › adds an item', 'cart › removes an item']);
  assert.equal(shape.tests.get('cart › adds an item').assertions, 2);
  assert.equal(shape.tests.get('cart › adds an item').line, 4);
});

test('an unchanged or stricter file is OK', () => {
  const stricter = BEFORE.replace("toBeVisible();\n  });\n\n  test('removes", "toBeVisible();\n    await expect(page).toHaveURL(/cart/);\n  });\n\n  test('removes");
  const result = guardFileChange('tests/cart.spec.ts', BEFORE, stricter);
  assert.deepEqual(result.findings, []);
  assert.equal(guardVerdict([result]), 'OK');
});

test('deleting an assertion, skipping or removing a test blocks', () => {
  const fewer = guardFileChange('a.spec.ts', BEFORE, BEFORE.replace("    await expect(page.getByRole('status')).toBeVisible();\n", ''));
  assert.deepEqual(fewer.findings.map((f) => [f.severity, f.rule, f.test]), [['block', 'assertions-removed', 'cart › adds an item']]);

  const skipped = guardFileChange('a.spec.ts', BEFORE, BEFORE.replace("test('removes an item'", "test.skip('removes an item'"));
  assert.ok(skipped.findings.some((f) => f.rule === 'skip-added' && f.severity === 'block'));

  const inner = guardFileChange('a.spec.ts', BEFORE, BEFORE.replace("await page.goto('/cart');", "test.skip(true, 'flaky');\n    await page.goto('/cart');"));
  assert.ok(inner.findings.some((f) => f.rule === 'skip-added'));

  const removed = guardFileChange('a.spec.ts', BEFORE, BEFORE.replace(/\n  test\('removes an item'[\s\S]*?\n  \}\);\n/, '\n'));
  assert.ok(removed.findings.some((f) => f.rule === 'test-removed' && f.test === 'cart › removes an item'));

  const only = guardFileChange('a.spec.ts', BEFORE, BEFORE.replace("test('adds an item'", "test.only('adds an item'"));
  assert.ok(only.findings.some((f) => f.rule === 'only-added'));

  const deleted = guardFileChange('a.spec.ts', BEFORE, undefined);
  assert.equal(deleted.findings[0].rule, 'file-deleted');
  assert.equal(guardVerdict([fewer]), 'BLOCK');
});

test('a renamed test is compared with its old self, not reported as removed', () => {
  const renamed = guardFileChange('a.spec.ts', BEFORE, BEFORE.replace("'removes an item'", "'removes the item'"));
  assert.deepEqual(renamed.findings, []);
});

test('weaker matchers, hard waits, force, swallowed errors, timeouts and retries warn', () => {
  const weaker = guardFileChange('a.spec.ts', BEFORE, BEFORE.replace("toHaveText('1')", 'toBeAttached()'));
  assert.deepEqual(weaker.findings.map((f) => f.rule), ['weaker-matcher']);

  const soft = guardFileChange('a.spec.ts', BEFORE, BEFORE.replace("await expect(page.getByTestId('count'))", "await expect.soft(page.getByTestId('count'))"));
  assert.deepEqual(soft.findings.map((f) => f.rule), ['assertion-softened']);

  const waits = guardFileChange(
    'a.spec.ts',
    BEFORE,
    BEFORE.replace(
      "await page.getByRole('button', { name: 'Add' }).click();",
      "await page.waitForTimeout(3000);\n    await page.getByRole('button', { name: 'Add' }).click({ force: true, timeout: 60000 }).catch(() => {});",
    ),
  );
  assert.deepEqual(waits.findings.map((f) => f.rule).sort(), ['error-swallowed', 'force-added', 'hard-wait-added', 'timeout-raised']);
  assert.equal(guardVerdict([waits]), 'WARN');

  const retries = guardFileChange('playwright.config.ts', 'export default { retries: 0 }', 'export default { retries: 3 }');
  assert.deepEqual(retries.findings.map((f) => f.rule), ['retries-raised']);

  const pixels = guardFileChange('a.spec.ts', "test('x', async () => { await expect(p).toHaveScreenshot({ maxDiffPixels: 10 }); });", "test('x', async () => { await expect(p).toHaveScreenshot({ maxDiffPixels: 500 }); });");
  assert.deepEqual(pixels.findings.map((f) => f.rule), ['screenshot-tolerance-raised']);
});

test('isGuardedFile picks specs and configs; the report names the verdict', () => {
  assert.equal(isGuardedFile('tests/cart.spec.ts'), true);
  assert.equal(isGuardedFile('e2e/helpers/login.ts'), true);
  assert.equal(isGuardedFile('playwright.config.ts'), true);
  assert.equal(isGuardedFile('src/app.ts'), false);
  const report = renderGuardReport([guardFileChange('a.spec.ts', BEFORE, BEFORE.replace("test('adds an item'", "test.fixme('adds an item'"))], 'x');
  assert.match(report, /^## 🛑 BLOCK/);
  assert.match(report, /a\.spec\.ts:4/);
});

test('assertGitRef refuses options and odd characters', () => {
  assert.equal(assertGitRef('origin/main'), 'origin/main');
  assert.equal(assertGitRef('HEAD~2'), 'HEAD~2');
  assert.throws(() => assertGitRef('--output=/tmp/x'), /Not a git ref/);
  assert.throws(() => assertGitRef('main;rm -rf'), /Not a git ref/);
  assert.throws(() => assertGitRef('a..b'), /Not a git ref/);
});

test('check-test-change compares the working tree with a git ref', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pw-guard-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    mkdirSync(path.join(root, 'tests'));
    writeFileSync(path.join(root, 'tests/cart.spec.ts'), BEFORE);
    writeFileSync(path.join(root, 'tests/new.spec.ts'), BEFORE);
    git('add', 'tests/cart.spec.ts');
    git('commit', '-qm', 'base');
    writeFileSync(path.join(root, 'tests/cart.spec.ts'), BEFORE.replace("    await expect(page.getByRole('status')).toBeVisible();\n", ''));
    writeFileSync(path.join(root, 'src.ts'), 'x');

    const results = await guardAgainstRef(root, 'HEAD');
    assert.deepEqual(results.map((r) => r.file), ['tests/cart.spec.ts']);

    const response = await checkTestChangeTool.handler({}, ctxFor(root));
    assert.match(textOf(response), /BLOCK/);
    assert.equal(response.structuredContent.ok, false);
    assert.equal(response.structuredContent.status, 'BLOCK');
    assert.equal(response.structuredContent.findings[0].rule, 'assertions-removed');

    const proposed = await checkTestChangeTool.handler({ file: 'tests/cart.spec.ts', after: readFileSync(path.join(root, 'tests/cart.spec.ts'), 'utf8') }, ctxFor(root));
    assert.match(textOf(proposed), /OK/);
    await assert.rejects(guardAgainstRef(root, 'no-such-branch'), /Unknown git ref/);

    // The same check as a CI step: exit 1 on BLOCK, 0 once the assertion is back, 2 on a bad ref.
    const cli = (...args) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [path.resolve('dist/index.js'), 'guard', ...args], { cwd: root, stdio: 'pipe', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } }).toString() };
      } catch (error) {
        return { code: error.status, out: `${error.stdout}${error.stderr}` };
      }
    };
    const blocked = cli();
    assert.equal(blocked.code, 1);
    assert.match(blocked.out, /BLOCK/);
    assert.equal(JSON.parse(cli('--json').out).verdict, 'BLOCK');
    assert.equal(cli('--base', '--oops').code, 2);
    writeFileSync(path.join(root, 'tests/cart.spec.ts'), BEFORE);
    assert.equal(cli().code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---------------- quarantine ---------------- */

const failure = (file, title, kind = 'assertion') => ({ file, title, status: 'failed', failureKind: kind, message: 'boom' });

test('quarantine entries match whole titles or their tail, and expire after their last day', () => {
  const entry = { file: 'tests/cart.spec.ts', title: 'adds an item', owner: 'ann', reason: 'race', until: '2026-11-10', added: '2026-10-28' };
  assert.equal(matchesEntry(entry, { file: 'tests/cart.spec.ts', title: 'cart › adds an item' }), true);
  assert.equal(matchesEntry(entry, { file: 'tests/cart.spec.ts', title: 'adds an item twice' }), false);
  assert.equal(matchesEntry(entry, { file: 'tests/other.spec.ts', title: 'adds an item' }), false);
  assert.equal(isExpired(entry, new Date('2026-11-10T23:00:00Z')), false);
  assert.equal(isExpired(entry, new Date('2026-11-11T00:00:01Z')), true);
  assert.equal(addDays('2026-10-28', 14), '2026-11-11');
});

test('a run whose only failures are quarantined passes; an expired entry blocks again', () => {
  const list = {
    version: 1,
    entries: [
      { file: 'a.spec.ts', title: 'flaky one', owner: 'ann', reason: 'race', until: '2999-01-01', added: '2026-10-28' },
      { file: 'a.spec.ts', title: 'old one', owner: 'bo', reason: 'x', until: '2000-01-01', added: '1999-12-01' },
    ],
  };
  const base = { ok: false, command: 'npx playwright test', durationMs: 10, exitCode: 1, stats: null, stderrTail: '' };

  const quarantinedOnly = { ...base, failures: [failure('a.spec.ts', 'suite › flaky one')] };
  const split = splitFailures(quarantinedOnly.failures, list);
  assert.equal(split.quarantined.length, 1);
  assert.equal(passesWithQuarantine(quarantinedOnly, split), true);
  const text = renderRunResult(quarantinedOnly, '/p', split);
  assert.match(text, /PASSED \(1 quarantined failure\)/);
  assert.match(text, /owner \*\*ann\*\*/);

  const expired = { ...base, failures: [failure('a.spec.ts', 'old one')] };
  const split2 = splitFailures(expired.failures, list);
  assert.equal(split2.expired.length, 1);
  assert.equal(passesWithQuarantine(expired, split2), false);
  assert.match(renderRunResult(expired, '/p', split2), /expired 2000-01-01/);

  const crashed = { ...base, errorKind: 'BROWSER_CRASH', failures: [failure('a.spec.ts', 'flaky one')] };
  assert.equal(passesWithQuarantine(crashed, splitFailures(crashed.failures, list)), false);
});

test('the quarantine tool adds with owner and reason, lists, extends and removes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pw-quarantine-'));
  try {
    const ctx = ctxFor(root);
    await assert.rejects(
      async () => {
        const r = await quarantineTool.handler({ action: 'add', test: 'tests/a.spec.ts › flaky' }, ctx);
        if (r.isError) throw new Error(textOf(r));
      },
      /owner and reason/,
    );
    const added = await quarantineTool.handler({ action: 'add', test: 'tests/a.spec.ts › suite › flaky [chromium]', owner: 'ann', reason: 'animation race, #12', days: 7 }, ctx);
    assert.equal(added.structuredContent.status, 'added');
    const saved = await readQuarantine(root);
    assert.equal(saved.entries[0].title, 'suite › flaky');
    assert.equal(saved.entries[0].owner, 'ann');

    const again = await quarantineTool.handler({ action: 'add', file: 'tests/a.spec.ts', title: 'suite › flaky', owner: 'bo', reason: 'still racing' }, ctx);
    assert.equal(again.structuredContent.status, 'extended');
    assert.equal((await readQuarantine(root)).entries.length, 1);

    const list = await quarantineTool.handler({}, ctx);
    assert.match(textOf(list), /1 quarantined test/);
    assert.match(textOf(list), /still racing/);

    // Reported titles carry the file name first; the entry is found either way.
    const prefixed = await quarantineTool.handler({ action: 'add', test: 'tests/a.spec.ts › a.spec.ts › suite › flaky', owner: 'cy', reason: 'same test' }, ctx);
    assert.equal(prefixed.structuredContent.status, 'extended');
    const removed = await quarantineTool.handler({ action: 'remove', test: 'tests/a.spec.ts › flaky' }, ctx);
    assert.equal(removed.structuredContent.status, 'removed');
    assert.equal((await readQuarantine(root)).entries.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeQuarantine keeps the list sorted and readable', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pw-quarantine-'));
  try {
    await writeQuarantine(root, {
      version: 1,
      entries: [
        { file: 'b.spec.ts', title: 'x', owner: 'a', reason: 'r', until: '2999-01-01', added: '2026-10-28' },
        { file: 'a.spec.ts', title: 'y', owner: 'a', reason: 'r', until: '2999-01-01', added: '2026-10-28' },
      ],
    });
    const json = JSON.parse(readFileSync(path.join(root, 'playwright-quarantine.json'), 'utf8'));
    assert.deepEqual(json.entries.map((e) => e.file), ['a.spec.ts', 'b.spec.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
