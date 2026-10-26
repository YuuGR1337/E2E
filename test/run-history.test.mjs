import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  errorSignature,
  failurePatterns,
  parseHistory,
  rankFlaky,
  recordRun,
  readHistory,
  testStats,
} from '../dist/utils/run-history.js';

function entry(at, tests) {
  return { v: 1, at, source: 'run-test', command: 'x', ok: true, durationMs: 1, stats: null, tests };
}
const t = (title, status, extra = {}) => ({ file: 'tests/a.spec.ts', title, project: 'chromium', status, ...extra });

const runs = [
  entry('2026-10-01T00:00:00Z', [t('flaky', 'passed'), t('broken', 'failed', { kind: 'timeout', msg: 'Timeout 5000ms exceeded' }), t('fixed', 'failed'), t('regressed', 'passed'), t('stable', 'passed')]),
  entry('2026-10-02T00:00:00Z', [t('flaky', 'failed', { kind: 'assertion', msg: "expect(locator).toHaveText('A')" }), t('broken', 'failed', { kind: 'timeout', msg: 'Timeout 3000ms exceeded' }), t('fixed', 'passed'), t('regressed', 'passed'), t('stable', 'passed')]),
  entry('2026-10-03T00:00:00Z', [t('flaky', 'passed'), t('broken', 'timedOut', { kind: 'timeout', msg: 'Timeout 7000ms exceeded' }), t('fixed', 'passed'), t('regressed', 'failed'), t('stable', 'passed')]),
  entry('2026-10-04T00:00:00Z', [t('flaky', 'flaky'), t('broken', 'failed', { kind: 'timeout', msg: 'Timeout 1000ms exceeded' }), t('fixed', 'passed'), t('regressed', 'failed'), t('stable', 'passed')]),
];

test('testStats: counts, flips and timeline strip', () => {
  const stats = Object.fromEntries(testStats(runs).map((s) => [s.title, s]));
  assert.equal(stats.flaky.strip, 'PFP~');
  assert.equal(stats.flaky.flips, 3);
  assert.equal(stats.broken.failed, 4);
  assert.equal(stats.stable.flips, 0);
});

test('rankFlaky: flaky vs broken vs regressed vs fixed', () => {
  const ranking = rankFlaky(runs);
  assert.deepEqual(ranking.flaky.map((s) => s.title), ['flaky']);
  assert.deepEqual(ranking.broken.map((s) => s.title), ['broken']);
  assert.deepEqual(ranking.regressed.map((s) => s.title), ['regressed']);
  assert.equal(ranking.stable, 2, 'stable + fixed');
});

test('failurePatterns: groups by kind and digit-folded error', () => {
  const patterns = failurePatterns(runs);
  assert.equal(patterns[0].kind, 'timeout');
  assert.equal(patterns[0].count, 4, 'four timeouts with different ms fold together');
  assert.equal(errorSignature("toHaveText('A')"), errorSignature('toHaveText("B")'));
});

test('parseHistory skips torn lines', () => {
  const text = `${JSON.stringify(runs[0])}\n{"v":1,"at":\n${JSON.stringify(runs[1])}\n`;
  assert.equal(parseHistory(text).length, 2);
});

test('recordRun writes history.jsonl with a .gitignore and reads it back', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pwmcp-hist-'));
  const result = {
    ok: false,
    command: 'playwright test',
    durationMs: 10,
    stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0, duration: 10 },
    outcomes: [
      { file: 'tests/a.spec.ts', title: 'a', status: 'passed', durationMs: 4 },
      { file: 'tests/a.spec.ts', title: 'b', status: 'failed', failureKind: 'assertion', message: 'boom' },
    ],
  };
  assert.equal(await recordRun(root, result, 'run-test'), true);
  assert.equal(await recordRun(root, { ...result, outcomes: [] }, 'run-test'), false, 'empty runs are skipped');
  const dir = path.join(root, '.playwright-e2e-mcp');
  assert.ok(existsSync(path.join(dir, '.gitignore')));
  assert.match(readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\*$/m);
  const entries = await readHistory(root, 10);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tests[1].msg, 'boom');
  assert.equal(entries[0].stats.failed, 1);
});

test('recordRun honours PW_MCP_HISTORY=0', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pwmcp-hist-'));
  process.env.PW_MCP_HISTORY = '0';
  try {
    assert.equal(await recordRun(root, { outcomes: [{ file: 'a', title: 'a', status: 'passed' }], stats: null }, 'x'), false);
  } finally {
    delete process.env.PW_MCP_HISTORY;
  }
});

test('slowTests: passing runs only, slowest first, slowdown after six runs', async () => {
  const { slowTests } = await import('../dist/utils/run-history.js');
  const ms = [100, 110, 90, 100, 300, 320];
  const history = ms.map((v, i) => entry(`2026-10-0${i + 1}T00:00:00Z`, [t('slow', 'passed', { ms: v }), t('fast', 'passed', { ms: 10 }), t('timeout', 'timedOut', { ms: 30_000 })]));
  const slow = slowTests(history);
  assert.deepEqual(slow.map((s) => s.key.includes('slow') ? 'slow' : 'fast'), ['slow', 'fast']);
  assert.equal(slow[0].runs, 6);
  assert.equal(slow[0].maxMs, 320);
  assert.equal(slow[0].slowdown, 3.1);
  assert.ok(!slow.some((s) => s.key.includes('timeout')), 'failed runs do not count');
});

test('dailyTrend: one row per day with the unstable rate', async () => {
  const { dailyTrend } = await import('../dist/utils/run-history.js');
  const days = dailyTrend([
    entry('2026-10-01T08:00:00Z', [t('a', 'passed'), t('b', 'failed')]),
    entry('2026-10-01T09:00:00Z', [t('a', 'flaky'), t('b', 'failed'), t('c', 'skipped')]),
    entry('2026-10-02T09:00:00Z', [t('a', 'passed'), t('b', 'passed')]),
  ]);
  assert.deepEqual(days.map((d) => [d.day, d.runs, d.executions, d.failed, d.flaky, d.unstableTests]), [
    ['2026-10-01', 2, 4, 2, 1, 2],
    ['2026-10-02', 1, 2, 0, 0, 0],
  ]);
  assert.equal(days[0].unstableRate, 0.75);
});

test('breakingCommits: names the first bad commit after the last passing streak', async () => {
  const { breakingCommits } = await import('../dist/utils/run-history.js');
  const at = (i, commit, tests) => ({ ...entry(`2026-10-${String(i).padStart(2, '0')}T00:00:00Z`, tests), commit, subject: `subject ${commit}` });
  const list = breakingCommits([
    at(1, 'c1', [t('broke', 'passed'), t('flaky', 'passed'), t('lucky', 'failed'), t('fine', 'passed')]),
    at(2, 'c2', [t('broke', 'passed'), t('flaky', 'passed'), t('lucky', 'passed'), t('fine', 'passed')]),
    at(3, 'c3', [t('broke', 'failed'), t('flaky', 'flaky'), t('lucky', 'passed'), t('fine', 'passed')]),
    at(4, 'c4', [t('broke', 'failed'), t('flaky', 'passed'), t('lucky', 'passed'), t('fine', 'passed')]),
    at(5, 'c5', [t('broke', 'failed'), t('flaky', 'failed'), t('lucky', 'passed'), t('fine', 'passed')]),
  ]);
  const byTitle = Object.fromEntries(list.map((b) => [b.test.split(' › ').pop().replace(/ \[.*$/, ''), b]));
  const broke = list.find((b) => b.test.includes('broke'));
  const flaky = list.find((b) => b.test.includes('flaky'));
  assert.ok(broke && flaky, JSON.stringify(Object.keys(byTitle)));
  assert.equal(broke.firstBad.commit, 'c3');
  assert.equal(broke.firstBad.subject, 'subject c3');
  assert.equal(broke.lastGood.commit, 'c2');
  assert.equal(broke.since, 'failing');
  assert.equal(flaky.firstBad.commit, 'c3');
  assert.equal(flaky.since, 'flaky');
  assert.ok(!list.some((b) => b.test.includes('lucky') || b.test.includes('fine')), 'recovered and healthy tests are left out');
});
