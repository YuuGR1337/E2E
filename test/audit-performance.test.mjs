import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetCheck,
  formatBytes,
  formatMs,
  mergeRuns,
  metricRows,
  perfFindings,
  rate,
  renderPerformance,
} from '../dist/tools/audit-performance.js';

function scan(overrides = {}) {
  return {
    ttfbMs: 40,
    fcpMs: 900,
    lcpMs: 3_200,
    lcpElement: 0,
    lcpTag: 'img',
    lcpUrl: 'http://app/hero.jpg',
    cls: 0.18,
    shiftElements: [1],
    tbtMs: 350,
    longTasks: 2,
    longestTaskMs: 300,
    requests: 12,
    transferBytes: 1_250_000,
    byType: [{ type: 'image', requests: 3, transferBytes: 900_000 }],
    largest: [{ url: 'http://app/hero.jpg', type: 'image', transferBytes: 800_000, durationMs: 1_400, renderBlocking: false }],
    renderBlocking: [{ url: 'http://app/app.css', type: 'stylesheet', transferBytes: 20_000, durationMs: 300, renderBlocking: true }],
    thirdPartyBytes: 0,
    thirdPartyOrigins: 0,
    domNodes: 420,
    ...overrides,
  };
}

const elements = [
  { tag: 'img', selector: '#hero', visible: true, attributes: {}, locators: [[{ method: 'getByRole', args: ['img', { name: 'Summer sale' }] }]] },
  { tag: 'ul', selector: '#cart', visible: true, attributes: {}, locators: [] },
];

test('rate uses the Web Vitals thresholds', () => {
  assert.equal(rate('lcp', 2_500), 'good');
  assert.equal(rate('lcp', 2_501), 'needs-improvement');
  assert.equal(rate('lcp', 4_001), 'poor');
  assert.equal(rate('cls', 0.05), 'good');
  assert.equal(rate('cls', 0.3), 'poor');
  assert.equal(rate('inp', 250), 'needs-improvement');
});

test('formatters', () => {
  assert.equal(formatMs(412), '412 ms');
  assert.equal(formatMs(3_200), '3.20 s');
  assert.equal(formatBytes(1_250_000), '1.3 MB');
  assert.equal(formatBytes(20_400), '20 kB');
  assert.equal(formatBytes(206), '206 B');
});

test('metricRows compares against budgets', () => {
  const rows = metricRows(scan(), { lcpMs: 4_000, cls: 0.1 });
  const lcp = rows.find((r) => r.spec.id === 'lcp');
  const cls = rows.find((r) => r.spec.id === 'cls');
  assert.equal(lcp.overBudget, false);
  assert.equal(cls.overBudget, true);
  assert.equal(rows.find((r) => r.spec.id === 'inp').value, undefined);
});

test('perfFindings names the LCP element, the shifted element and the long tasks', () => {
  const findings = perfFindings({ elements, elementCount: 2, matchCount: 0, perf: scan() });
  const text = findings.join('\n');
  assert.match(text, /\*\*LCP 3\.20 s\*\* is the img loading `http:\/\/app\/hero\.jpg` \(`getByRole\('img', \{ name: 'Summer sale' \}\)`\)/);
  assert.match(text, /render-blocking/);
  assert.match(text, /\*\*CLS 0\.180\*\*: these moved: `#cart`/);
  assert.match(text, /\*\*TBT 350 ms\*\* from 2 long task/);
  assert.equal(perfFindings({ elements, elementCount: 2, matchCount: 0, perf: scan({ lcpMs: 1_000, cls: 0, tbtMs: 0 }) }).length, 0);
});

test('mergeRuns takes medians and keeps the run closest to the median LCP', () => {
  const runs = [1_000, 3_000, 2_000].map((lcpMs, i) => ({ elements: [], elementCount: 0, matchCount: 0, finalUrl: `http://app/?run=${i}`, perf: scan({ lcpMs, tbtMs: lcpMs / 10 }) }));
  const { data, spread } = mergeRuns(runs);
  assert.equal(data.perf.lcpMs, 2_000);
  assert.equal(data.perf.tbtMs, 200);
  assert.equal(data.finalUrl, 'http://app/?run=2');
  assert.deepEqual(spread, { lcp: [1_000, 3_000] });
  assert.equal(mergeRuns([runs[0]]).spread, undefined);
});

test('renderPerformance leads with the verdict and ends with a budget check', () => {
  const data = { elements, elementCount: 2, matchCount: 0, finalUrl: 'http://app/', perf: scan() };
  const rated = renderPerformance('http://app/', data, { profile: 'desktop', runs: 1 });
  assert.match(rated, /^## ⚡ 3 of 5 metrics need work \(LCP, CLS, TBT\)/);
  assert.ok(rated.includes('| LCP · largest contentful paint | 3.20 s | 🟠 needs improvement |'));
  assert.ok(!rated.includes('| INP'), 'INP row is hidden when no actions ran');
  assert.ok(rated.includes("test('stays within the performance budget'"));

  const budgeted = renderPerformance('http://app/', data, { profile: 'desktop', runs: 1, budgets: { lcpMs: 4_000, transferKb: 500 } });
  assert.match(budgeted, /^## ❌ 1 performance budget exceeded \(transfer size\)/);
  assert.ok(budgeted.includes('✅ ≤ 4.00 s'));
  assert.ok(budgeted.includes('(budget 500 kB ❌)'));

  const clean = renderPerformance('http://app/', { ...data, perf: scan({ lcpMs: 900, cls: 0, tbtMs: 0 }) }, { profile: 'desktop', runs: 1 });
  assert.match(clean, /^## ✅ All measured Web Vitals are good/);
});

test('budgetCheck uses the given budgets', () => {
  const code = budgetCheck('http://app/cart', { lcpMs: 1_800, cls: 0.05 });
  assert.ok(code.includes('page.goto("http://app/cart")'));
  assert.ok(code.includes('expect(vitals.lcp).toBeLessThan(1800)'));
  assert.ok(code.includes('expect(vitals.cls).toBeLessThan(0.05)'));
});
