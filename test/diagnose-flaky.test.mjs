import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evidenceTarget,
  failureSignature,
  groupAttempts,
  isolationReading,
  summarizeFlaky,
} from '../dist/tools/diagnose-flaky.js';
import { parseAttempts } from '../dist/utils/attempts-reporter.js';

test('failureSignature normalizes messages for comparison', () => {
  const sig = failureSignature({
    message: 'Error: expect(received).toBe(expected)\n  at tests/a.spec.ts:4',
  });
  assert.equal(sig, 'error: expect(received).tobe(expected)');

  // Digits fold so timings/selectors do not create fake distinct errors.
  const a = failureSignature({ message: 'Timeout 30000ms exceeded waiting for #btn-12' });
  const b = failureSignature({ message: 'Timeout 5000ms exceeded waiting for #btn-99' });
  assert.equal(a, b, 'digit-folded signatures match');

  // Only the first line participates.
  const multi = failureSignature({ message: 'first line\nsecond line' });
  assert.equal(multi, 'first line');

  assert.equal(failureSignature(undefined), undefined);
  assert.equal(failureSignature({ message: '   ' }), undefined);
});

test('summarizeFlaky: same error every run → CONSISTENTLY FAILING', () => {
  const summary = summarizeFlaky([
    { ok: false, durationMs: 1000, signature: 'same error' },
    { ok: false, durationMs: 1100, signature: 'same error' },
    { ok: false, durationMs: 900, signature: 'same error' },
  ]);
  assert.equal(summary.verdict, 'CONSISTENTLY FAILING');
  assert.equal(summary.passed, 0);
  assert.equal(summary.failed, 3);
  assert.equal(summary.distinctSignatures, 1);
  assert.equal(summary.sameError, true);
});

test('summarizeFlaky: different errors while always failing still CONSISTENTLY FAILING', () => {
  const summary = summarizeFlaky([
    { ok: false, durationMs: 1, signature: 'error a' },
    { ok: false, durationMs: 1, signature: 'error b' },
  ]);
  assert.equal(summary.verdict, 'CONSISTENTLY FAILING');
  assert.equal(summary.distinctSignatures, 2);
  assert.equal(summary.sameError, false);
});

test('summarizeFlaky: mixed pass/fail → FLAKY', () => {
  const summary = summarizeFlaky([
    { ok: false, durationMs: 1000, signature: 'net error' },
    { ok: true, durationMs: 800 },
    { ok: true, durationMs: 750 },
  ]);
  assert.equal(summary.verdict, 'FLAKY');
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 1);
});

test('summarizeFlaky: all runs pass → NOT REPRODUCING', () => {
  const summary = summarizeFlaky([
    { ok: true, durationMs: 1 },
    { ok: true, durationMs: 1 },
    { ok: true, durationMs: 1 },
  ]);
  assert.equal(summary.verdict, 'NOT REPRODUCING');
  assert.equal(summary.passed, 3);
  assert.equal(summary.failed, 0);
});

test('summarizeFlaky: no tests executed → NO TESTS RAN', () => {
  const summary = summarizeFlaky([
    { ok: false, durationMs: 10, noTests: true },
    { ok: false, durationMs: 10, noTests: true },
  ]);
  assert.equal(summary.verdict, 'NO TESTS RAN');
  assert.equal(summary.passed, 0);
  assert.equal(summary.failed, 0);
});

const attempt = (over) => ({
  file: 'tests/a.spec.ts',
  line: 3,
  title: 'a › works',
  project: 'chromium',
  repeatEachIndex: 0,
  retry: 0,
  status: 'passed',
  expectedStatus: 'passed',
  durationMs: 100,
  ...over,
});

test('groupAttempts keeps one evidence row per test and project', () => {
  const groups = groupAttempts([
    attempt({ repeatEachIndex: 0, status: 'failed', message: 'Error: boom 12' }),
    attempt({ repeatEachIndex: 1 }),
    attempt({ repeatEachIndex: 0, project: 'firefox' }),
    attempt({ repeatEachIndex: 2, status: 'timedOut', message: 'Test timeout of 30000ms exceeded.' }),
    attempt({ file: 'tests/b.spec.ts', line: 9, title: 'b', status: 'skipped' }),
  ]);
  assert.equal(groups.length, 3);
  const chromium = groups[0];
  assert.equal(chromium.outcomes.length, 3);
  const summary = summarizeFlaky(chromium.outcomes);
  assert.equal(summary.verdict, 'FLAKY');
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 2);
  assert.equal(summary.distinctSignatures, 2);
  assert.equal(summarizeFlaky(groups[1].outcomes).verdict, 'NOT REPRODUCING');
  assert.equal(summarizeFlaky(groups[2].outcomes).verdict, 'NO TESTS RAN');
  assert.equal(evidenceTarget(groups[2]), 'tests/b.spec.ts:9');
});

test('groupAttempts honours test.fail() expectations', () => {
  const [group] = groupAttempts([attempt({ status: 'failed', expectedStatus: 'failed' })]);
  assert.equal(group.outcomes[0].ok, true);
});

test('isolationReading separates parallelism bugs from races inside the test', () => {
  const s = (passed, failed) => ({ verdict: 'FLAKY', passed, failed, distinctSignatures: 1, sameError: true });
  assert.equal(isolationReading(s(1, 2), s(3, 0)), 'PARALLEL ONLY');
  assert.equal(isolationReading(s(1, 2), s(2, 1)), 'FLAKY ALONE TOO');
  assert.equal(isolationReading(s(0, 3), s(0, 3)), 'FAILS EITHER WAY');
  assert.equal(isolationReading(s(3, 0), undefined), 'NOT REPRODUCING');
});

test('parseAttempts relativizes paths, strips ANSI and skips junk lines', () => {
  const root = '/proj';
  const raw = [
    JSON.stringify({ file: '/proj/tests/a.spec.ts', line: 3, title: 'works', project: 'chromium', repeatEachIndex: 1, retry: 0, status: 'failed', expectedStatus: 'passed', durationMs: 42, workerIndex: 2, message: '\u001b[31mError\u001b[39m: boom' }),
    'not json',
    JSON.stringify({ file: '/elsewhere/x.spec.ts', title: 'x', status: 'interrupted' }),
    JSON.stringify({ nope: true }),
    '',
  ].join('\n');
  const attempts = parseAttempts(raw, root);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].file, 'tests/a.spec.ts');
  assert.equal(attempts[0].message, 'Error: boom');
  assert.equal(attempts[0].repeatEachIndex, 1);
  assert.equal(attempts[1].file, '/elsewhere/x.spec.ts');
  assert.equal(attempts[1].status, 'failed');
  assert.equal(attempts[1].durationMs, 0);
});
