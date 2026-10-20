import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterFailures, renderRunResult } from '../dist/tools/run-test.js';

const fail = (title, line, message, kind = 'server-unreachable') => ({
  file: 'tests/shop.spec.ts', line, title, status: 'failed', failureKind: kind, message,
});

test('clusterFailures groups failures with the same kind and first error line, numbers aside', () => {
  const clusters = clusterFailures([
    fail('home', 3, 'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/'),
    fail('cart', 9, 'locator.click: Timeout 5000ms exceeded.\nwaiting for getByTestId("buy")', 'timeout'),
    fail('search', 15, 'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3001/search'.replace('3001/search', '3000/')),
    fail('login', 21, 'locator.click: Timeout 7000ms exceeded.\nwaiting for getByRole("button")', 'timeout'),
  ]);
  assert.deepEqual(clusters.map((c) => c.indexes), [[0, 2], [1, 3]]);
  assert.equal(clusters[0].kind, 'server-unreachable');
});

test('renderRunResult shows a shared cause once and lists the other tests compactly', () => {
  const failures = [
    fail('home', 3, 'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/'),
    fail('search', 15, 'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/'),
    fail('cart', 9, 'expect(received).toBe(expected)', 'assertion'),
  ];
  const text = renderRunResult({ ok: false, command: 'npx playwright test', durationMs: 10, exitCode: 1, stats: null, failures, stderrTail: '' }, '/p');
  assert.ok(text.includes('**2 distinct causes** for 3 failures'));
  assert.ok(text.includes('#### Same cause in 2 tests: page.goto: net::ERR_CONNECTION_REFUSED'));
  assert.ok(text.includes('### 1 of 3. home'));
  assert.ok(text.includes('- 2 of 3. search · `tests/shop.spec.ts:15`'));
  assert.ok(!text.includes('### 2 of 3. search'));
  assert.ok(text.includes('### 3 of 3. cart'));
});

test('renderRunResult keeps the full list when every failure is different', () => {
  const failures = [fail('a', 1, 'boom one', 'assertion'), fail('b', 2, 'other problem', 'assertion')];
  const text = renderRunResult({ ok: false, command: 'x', durationMs: 1, exitCode: 1, stats: null, failures, stderrTail: '' }, '/p');
  assert.ok(!text.includes('distinct cause'));
  assert.ok(text.includes('### 1 of 2. a') && text.includes('### 2 of 2. b'));
});
