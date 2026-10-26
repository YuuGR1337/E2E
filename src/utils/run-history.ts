/**
 * Local run history: every run the server performs appends one line to
 * `<project>/.playwright-e2e-mcp/history.jsonl`, so flakiness and failure
 * patterns can be judged across runs instead of from one red build.
 *
 * Nothing leaves the machine. The folder gets its own `.gitignore` (`*`) so
 * it never lands in a commit, the file is trimmed to MAX_ENTRIES, and
 * PW_MCP_HISTORY=0 turns recording off.
 *
 * The analysis functions are pure (exported for unit tests).
 */

import { execFile } from 'node:child_process';
import { appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { FailureKind, GitInfo, RunTestResult, TestOutcome, TestStatus } from '../types/index.js';
import { PlaywrightMcpError } from '../types/index.js';
import { assertRealPathInside, joinProjectPath, toNativePath, writeFileInsideRoot } from './path-utils.js';

export const HISTORY_DIR = '.playwright-e2e-mcp';
const HISTORY_FILE = 'history.jsonl';
const MAX_ENTRIES = 500;
const MAX_TESTS_PER_ENTRY = 2_000;

export interface HistoryTest {
  file: string;
  title: string;
  project?: string;
  status: TestStatus;
  ms?: number;
  kind?: FailureKind;
  msg?: string;
}

export interface HistoryEntry {
  v: 1;
  at: string;
  source: string;
  command: string;
  ok: boolean;
  durationMs: number;
  stats: { passed: number; failed: number; flaky: number; skipped: number } | null;
  tests: HistoryTest[];
  /** The commit the run tested (0.5.0+); `dirty` when the checkout had local changes. */
  commit?: string;
  branch?: string;
  subject?: string;
  dirty?: boolean;
  /** Where the result came from when it was not run here, e.g. a CI build link. */
  buildUrl?: string;
}

function git(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 3_000, windowsHide: true, maxBuffer: 1_000_000 }, (err, stdout) => {
      resolve(err ? undefined : String(stdout).trim());
    });
  });
}

/** The checked-out commit of `root`, or nothing when it is not a git repository. */
export async function localGitInfo(root: string): Promise<(GitInfo & { dirty?: boolean }) | undefined> {
  const native = toNativePath(root);
  const commit = await git(['rev-parse', 'HEAD'], native);
  if (!commit || !/^[0-9a-f]{7,64}$/i.test(commit)) return undefined;
  const [branch, subject, status] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], native),
    git(['log', '-1', '--pretty=%s'], native),
    git(['status', '--porcelain', '--untracked-files=no'], native),
  ]);
  return {
    commit,
    branch: branch && branch !== 'HEAD' ? branch : undefined,
    subject: subject ? subject.slice(0, 200) : undefined,
    dirty: status ? status.length > 0 : undefined,
  };
}

export function historyEnabled(): boolean {
  const flag = (process.env.PW_MCP_HISTORY ?? '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off');
}

export function historyPath(root: string): string {
  return joinProjectPath(root, HISTORY_DIR, HISTORY_FILE);
}

export function toHistoryEntry(
  result: RunTestResult,
  source: string,
  at = new Date(),
  gitInfo?: GitInfo & { dirty?: boolean },
): HistoryEntry {
  const tests = (result.outcomes ?? []).slice(0, MAX_TESTS_PER_ENTRY).map((o: TestOutcome) => {
    const test: HistoryTest = { file: o.file, title: o.title, status: o.status };
    if (o.project) test.project = o.project;
    if (o.durationMs !== undefined) test.ms = Math.round(o.durationMs);
    if (o.failureKind) test.kind = o.failureKind;
    if (o.message) test.msg = o.message;
    return test;
  });
  return {
    v: 1,
    at: at.toISOString(),
    source,
    command: result.command,
    ok: result.ok,
    durationMs: result.durationMs,
    stats: result.stats
      ? { passed: result.stats.expected, failed: result.stats.unexpected, flaky: result.stats.flaky, skipped: result.stats.skipped }
      : null,
    tests,
    ...(gitInfo?.commit ? { commit: gitInfo.commit } : {}),
    ...(gitInfo?.branch ? { branch: gitInfo.branch } : {}),
    ...(gitInfo?.subject ? { subject: gitInfo.subject } : {}),
    ...(gitInfo?.dirty ? { dirty: true } : {}),
    ...(gitInfo?.buildUrl ? { buildUrl: gitInfo.buildUrl } : {}),
  };
}

/** Append a run to the project's history (no-op when disabled or nothing ran). */
export async function recordRun(
  root: string,
  result: RunTestResult,
  source: string,
  options: { at?: Date; git?: GitInfo } = {},
): Promise<boolean> {
  if (!historyEnabled()) return false;
  if (!result.outcomes || result.outcomes.length === 0) return false;
  // A run done here tested the working tree; an imported one says which commit it tested.
  const gitInfo = options.git ?? (await localGitInfo(root).catch(() => undefined));
  const dir = joinProjectPath(root, HISTORY_DIR);
  await mkdir(toNativePath(dir), { recursive: true });
  // The folder could be a symlink planted in the project; keep writes inside.
  await assertRealPathInside(dir, root);
  const ignore = joinProjectPath(dir, '.gitignore');
  if (!(await lstat(toNativePath(ignore)).catch(() => null))) {
    await writeFileInsideRoot(ignore, '# Local run history written by playwright-e2e-mcp\n*\n', root);
  }
  const file = historyPath(root);
  const info = await lstat(toNativePath(file)).catch(() => null);
  if (info?.isSymbolicLink()) {
    throw new PlaywrightMcpError('Refusing to write run history through a symlink', 'INVALID_PATH');
  }
  await appendFile(toNativePath(file), `${JSON.stringify(toHistoryEntry(result, source, options.at, gitInfo))}\n`, 'utf8');
  // Trim now and then, not on every write.
  if (info && info.size > 4_000_000) {
    const lines = (await readFile(toNativePath(file), 'utf8')).split('\n').filter((line) => line.trim() !== '');
    if (lines.length > MAX_ENTRIES) await writeFile(toNativePath(file), `${lines.slice(-MAX_ENTRIES).join('\n')}\n`, 'utf8');
  }
  return true;
}

/** Parse history lines, skipping anything malformed. Oldest first. */
export function parseHistory(text: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line) as HistoryEntry;
      if (entry && entry.v === 1 && Array.isArray(entry.tests)) out.push(entry);
    } catch {
      /* skip a torn or hand-edited line */
    }
  }
  return out;
}

export async function readHistory(root: string, lastRuns: number): Promise<HistoryEntry[]> {
  const file = historyPath(root);
  await assertRealPathInside(file, root);
  const text = await readFile(toNativePath(file), 'utf8').catch(() => '');
  return parseHistory(text).slice(-lastRuns);
}

/* ------------------------------------------------------------------ */
/* Analysis                                                            */
/* ------------------------------------------------------------------ */

export function testKey(test: { file: string; title: string; project?: string }): string {
  return `${test.file} › ${test.title}${test.project ? ` [${test.project}]` : ''}`;
}

const FAILED: ReadonlySet<TestStatus> = new Set<TestStatus>(['failed', 'timedOut']);

export interface TestStats {
  key: string;
  file: string;
  title: string;
  project?: string;
  runs: number;
  passed: number;
  failed: number;
  /** Passed only on a retry. */
  flaky: number;
  /** Changes between pass and fail across consecutive runs. */
  flips: number;
  /** (failed + flaky) / runs */
  failRate: number;
  /** flips / (runs - 1) */
  flipRate: number;
  /** Outcomes oldest first: P pass, F fail, ~ flaky, - skipped. */
  strip: string;
  lastStatus: TestStatus;
  lastAt: string;
  avgMs?: number;
}

function letter(status: TestStatus): string {
  if (status === 'passed') return 'P';
  if (FAILED.has(status)) return 'F';
  if (status === 'flaky') return '~';
  return '-';
}

/** Per-test statistics across the given runs (oldest first). */
export function testStats(entries: HistoryEntry[]): TestStats[] {
  const map = new Map<string, { test: HistoryTest; statuses: TestStatus[]; ms: number[]; lastAt: string }>();
  for (const entry of entries) {
    for (const test of entry.tests) {
      const key = testKey(test);
      const slot = map.get(key) ?? { test, statuses: [], ms: [], lastAt: entry.at };
      slot.statuses.push(test.status);
      if (test.ms !== undefined) slot.ms.push(test.ms);
      slot.lastAt = entry.at;
      map.set(key, slot);
    }
  }
  const out: TestStats[] = [];
  for (const [key, slot] of map) {
    const ran = slot.statuses.filter((s) => s !== 'skipped' && s !== 'unknown');
    const passed = ran.filter((s) => s === 'passed').length;
    const failed = ran.filter((s) => FAILED.has(s)).length;
    const flaky = ran.filter((s) => s === 'flaky').length;
    let flips = 0;
    for (let i = 1; i < ran.length; i += 1) {
      const prevBad = ran[i - 1] !== 'passed';
      const curBad = ran[i] !== 'passed';
      if (prevBad !== curBad) flips += 1;
    }
    out.push({
      key,
      file: slot.test.file,
      title: slot.test.title,
      project: slot.test.project,
      runs: ran.length,
      passed,
      failed,
      flaky,
      flips,
      failRate: ran.length > 0 ? (failed + flaky) / ran.length : 0,
      flipRate: ran.length > 1 ? flips / (ran.length - 1) : 0,
      strip: slot.statuses.map(letter).join(''),
      lastStatus: slot.statuses[slot.statuses.length - 1],
      lastAt: slot.lastAt,
      avgMs: slot.ms.length > 0 ? Math.round(slot.ms.reduce((a, b) => a + b, 0) / slot.ms.length) : undefined,
    });
  }
  return out;
}

export interface FlakyRanking {
  /** Goes back and forth: passed on a retry, or flipped pass/fail twice or more. */
  flaky: TestStats[];
  /** Failed every time it ran in the window (at least twice). */
  broken: TestStats[];
  /** Passed earlier in the window, failing since (one flip, last run failed). */
  regressed: TestStats[];
  /** Everything else, including tests that failed and were then fixed. */
  stable: number;
}

/**
 * Rank unstable tests. Flaky means the outcome changes back and forth, so a
 * test that failed and was then fixed (one flip, now passing) is not flaky,
 * and one that started failing and keeps failing is a regression. More
 * flips and a higher failure share rank a flaky test higher.
 */
export function rankFlaky(entries: HistoryEntry[]): FlakyRanking {
  const stats = testStats(entries);
  const lastFailed = (s: TestStats): boolean => FAILED.has(s.lastStatus);
  const flaky = stats
    .filter((s) => s.flaky > 0 || s.flips >= 2)
    .sort((a, b) => b.flipRate - a.flipRate || b.failRate - a.failRate || b.runs - a.runs || a.key.localeCompare(b.key));
  const broken = stats
    .filter((s) => s.runs >= 2 && s.failed === s.runs)
    .sort((a, b) => b.runs - a.runs || a.key.localeCompare(b.key));
  const regressed = stats
    .filter((s) => s.flaky === 0 && s.flips === 1 && lastFailed(s))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.key.localeCompare(b.key));
  return { flaky, broken, regressed, stable: stats.length - flaky.length - broken.length - regressed.length };
}

/** Fold digits, quoted values and whitespace so equal causes group together. */
export function errorSignature(message: string | undefined): string {
  return (message ?? '')
    .toLowerCase()
    .replace(/(['"`]).*?\1/g, '"…"')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export interface FailurePattern {
  kind: string;
  signature: string;
  example: string;
  count: number;
  tests: string[];
  lastAt: string;
}

/** Group failures across runs by kind + normalized error, biggest first. */
export function failurePatterns(entries: HistoryEntry[]): FailurePattern[] {
  const map = new Map<string, FailurePattern>();
  for (const entry of entries) {
    for (const test of entry.tests) {
      if (!FAILED.has(test.status) && test.status !== 'flaky') continue;
      if (!test.msg && test.status === 'flaky') continue;
      const kind = test.kind ?? 'unknown';
      const signature = errorSignature(test.msg);
      const id = `${kind}|${signature}`;
      const pattern = map.get(id) ?? { kind, signature, example: test.msg ?? '', count: 0, tests: [], lastAt: entry.at };
      pattern.count += 1;
      const key = testKey(test);
      if (!pattern.tests.includes(key)) pattern.tests.push(key);
      pattern.lastAt = entry.at;
      map.set(id, pattern);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || b.tests.length - a.tests.length);
}

/* ------------------------------------------------------------------ */
/* Slow tests, trend, and the commit that broke a test                  */
/* ------------------------------------------------------------------ */

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface SlowTest {
  key: string;
  runs: number;
  medianMs: number;
  maxMs: number;
  /** Median of the newest third of runs over the median of the rest (needs 6+ runs). */
  slowdown?: number;
}

/** Tests by typical duration (passing runs only, so timeouts do not dominate), slowest first. */
export function slowTests(entries: HistoryEntry[]): SlowTest[] {
  const map = new Map<string, number[]>();
  for (const entry of entries) {
    for (const test of entry.tests) {
      if (test.ms === undefined || (test.status !== 'passed' && test.status !== 'flaky')) continue;
      const key = testKey(test);
      const list = map.get(key) ?? [];
      list.push(test.ms);
      map.set(key, list);
    }
  }
  const out: SlowTest[] = [];
  for (const [key, ms] of map) {
    const item: SlowTest = { key, runs: ms.length, medianMs: Math.round(median(ms)), maxMs: Math.max(...ms) };
    if (ms.length >= 6) {
      const cut = Math.floor((ms.length * 2) / 3);
      const before = median(ms.slice(0, cut));
      if (before > 0) item.slowdown = Math.round((median(ms.slice(cut)) / before) * 100) / 100;
    }
    out.push(item);
  }
  return out.sort((a, b) => b.medianMs - a.medianMs || a.key.localeCompare(b.key));
}

export interface TrendDay {
  day: string;
  runs: number;
  /** Test executions that day (one per test per run). */
  executions: number;
  failed: number;
  flaky: number;
  /** (failed + flaky) / executions */
  unstableRate: number;
  /** Distinct tests that failed or passed only on retry that day. */
  unstableTests: number;
}

/** One row per UTC day: how many tests failed or flaked, oldest first. */
export function dailyTrend(entries: HistoryEntry[]): TrendDay[] {
  const days = new Map<string, { runs: number; executions: number; failed: number; flaky: number; tests: Set<string> }>();
  for (const entry of entries) {
    const day = entry.at.slice(0, 10);
    const slot = days.get(day) ?? { runs: 0, executions: 0, failed: 0, flaky: 0, tests: new Set<string>() };
    slot.runs += 1;
    for (const test of entry.tests) {
      if (test.status === 'skipped' || test.status === 'unknown') continue;
      slot.executions += 1;
      if (FAILED.has(test.status)) slot.failed += 1;
      if (test.status === 'flaky') slot.flaky += 1;
      if (test.status !== 'passed') slot.tests.add(testKey(test));
    }
    days.set(day, slot);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, d]) => ({
      day,
      runs: d.runs,
      executions: d.executions,
      failed: d.failed,
      flaky: d.flaky,
      unstableRate: d.executions > 0 ? (d.failed + d.flaky) / d.executions : 0,
      unstableTests: d.tests.size,
    }));
}

export interface BreakingCommit {
  test: string;
  /** Last commit on which the test passed before its current bad streak. */
  lastGood?: { commit?: string; at: string };
  /** First run of the current bad streak. */
  firstBad: { commit?: string; subject?: string; at: string; status: TestStatus };
  /** How the test has behaved since: 'failing' every run, or 'flaky' (back and forth). */
  since: 'failing' | 'flaky';
}

/**
 * For each test that is failing or flaky now, the commit where that began:
 * the first bad run after its last passing streak (at least two passes in
 * a row, so one lucky pass of a flaky test does not count as good).
 */
export function breakingCommits(entries: HistoryEntry[]): BreakingCommit[] {
  const runs = new Map<string, Array<{ status: TestStatus; entry: HistoryEntry }>>();
  for (const entry of entries) {
    for (const test of entry.tests) {
      if (test.status === 'skipped' || test.status === 'unknown') continue;
      const key = testKey(test);
      const list = runs.get(key) ?? [];
      list.push({ status: test.status, entry });
      runs.set(key, list);
    }
  }
  const out: BreakingCommit[] = [];
  for (const [test, list] of runs) {
    if (!list.some((r) => r.status !== 'passed')) continue;
    // The newest stretch of two or more passes ends where the bad period starts.
    let goodEnd = -1;
    for (let i = list.length - 1; i >= 1; i -= 1) {
      if (list[i].status === 'passed' && list[i - 1].status === 'passed') {
        goodEnd = i;
        break;
      }
    }
    const firstBadIndex = list.findIndex((r, i) => i > goodEnd && r.status !== 'passed');
    if (firstBadIndex < 0) continue; // healthy again since its last bad run
    const tail = list.slice(firstBadIndex);
    const lastStatus = list[list.length - 1].status;
    const allBad = tail.every((r) => FAILED.has(r.status));
    if (lastStatus === 'passed' && tail.filter((r) => r.status !== 'passed').length < 2) continue;
    const bad = list[firstBadIndex];
    out.push({
      test,
      lastGood: goodEnd >= 0 ? { commit: list[goodEnd].entry.commit, at: list[goodEnd].entry.at } : undefined,
      firstBad: { commit: bad.entry.commit, subject: bad.entry.subject, at: bad.entry.at, status: bad.status },
      since: allBad ? 'failing' : 'flaky',
    });
  }
  return out.sort((a, b) => b.firstBad.at.localeCompare(a.firstBad.at) || a.test.localeCompare(b.test));
}
