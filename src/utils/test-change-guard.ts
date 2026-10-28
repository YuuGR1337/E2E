/**
 * Heal guard: compare a test file before and after a fix and catch the
 * changes that make a failing test pass by testing less — an assertion
 * deleted, a test skipped or removed, a matcher swapped for a weaker one,
 * a hard wait, a forced click, an error swallowed, a timeout or retry
 * count blown up.
 *
 * AI healers (Playwright's Healer agent, ours, any agent editing specs)
 * are good at turning red tests green; this is the reviewer that checks
 * they did it honestly. The scan is lexical: strings and comments are
 * masked so their words do not count, then each test(...) call is matched
 * by its describe path and title across the two versions.
 */

export type GuardSeverity = 'block' | 'warn';

export interface GuardFinding {
  severity: GuardSeverity;
  rule: string;
  /** "describe › title", or undefined for file-level findings. */
  test?: string;
  message: string;
  /** 1-based line in the new version, when the test still exists. */
  line?: number;
}

export interface GuardFileResult {
  file: string;
  findings: GuardFinding[];
  testsBefore: number;
  testsAfter: number;
}

export type GuardVerdict = 'BLOCK' | 'WARN' | 'OK';

/** Matchers that check a specific value or state. */
const STRONG = new Set([
  'toHaveText',
  'toHaveValue',
  'toHaveValues',
  'toHaveURL',
  'toHaveTitle',
  'toEqual',
  'toStrictEqual',
  'toBe',
  'toHaveCount',
  'toHaveAttribute',
  'toHaveClass',
  'toHaveCSS',
  'toHaveId',
  'toHaveJSProperty',
  'toHaveLength',
  'toHaveProperty',
  'toBeVisible',
  'toBeHidden',
  'toBeChecked',
  'toBeEnabled',
  'toBeDisabled',
  'toBeEditable',
  'toBeFocused',
  'toBeEmpty',
  'toMatch',
  'toMatchObject',
  'toMatchAriaSnapshot',
  'toHaveScreenshot',
  'toMatchSnapshot',
  'toHaveAccessibleName',
  'toHaveAccessibleDescription',
  'toHaveRole',
  'toBeInViewport',
  'toContain',
  'toContainEqual',
  'toThrow',
  'toBeOK',
]);

/** Matchers that pass for almost any value or state. */
const WEAK = new Set([
  'toBeTruthy',
  'toBeFalsy',
  'toBeDefined',
  'toBeUndefined',
  'toBeNull',
  'toBeAttached',
  'toContainText',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeInstanceOf',
]);

/**
 * Replace the inside of strings, template literals and comments with
 * spaces (newlines kept), so positions and line numbers stay the same
 * and no word inside them looks like code.
 */
export function maskCode(source: string): string {
  const out = source.split('');
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        if (source[j] === '\\') j += 1;
        else if (c !== '`' && source[j] === '\n') break;
        j += 1;
      }
      blank(i + 1, Math.min(j, source.length));
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

/** Index of the parenthesis closing the one at `open` in masked code, or -1. */
function closingParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return c === ')' ? i : -1;
    }
  }
  return -1;
}

/** The string literal starting at `at` in the original source (after whitespace), or undefined. */
function stringArgument(source: string, at: number): string | undefined {
  let i = at;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  const quote = source[i];
  if (quote !== '"' && quote !== "'" && quote !== '`') return undefined;
  let j = i + 1;
  let text = '';
  while (j < source.length && source[j] !== quote) {
    if (source[j] === '\\' && j + 1 < source.length) {
      text += source[j + 1];
      j += 2;
      continue;
    }
    text += source[j];
    j += 1;
  }
  return text;
}

interface Block {
  title: string;
  start: number;
  end: number;
  modifier?: string;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

export interface TestShape {
  key: string;
  title: string;
  line: number;
  modifier?: string;
  assertions: number;
  soft: number;
  conditionalSkips: number;
  hardWaits: number;
  forced: number;
  swallowed: number;
  tries: number;
  maxTimeout: number;
  strong: number;
  weak: number;
  body: string;
}

export interface FileShape {
  tests: Map<string, TestShape>;
  only: number;
  describeSkips: number;
  maxRetries: number;
  maxDiffAllowance: number;
}

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

function maxNumber(text: string, re: RegExp): number {
  let max = 0;
  for (const match of text.matchAll(re)) {
    const value = Number(match[match.length - 1].replace(/_/g, ''));
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
}

/** Find every test(...) and describe(...) with a string title, and measure each test. */
export function shapeOf(source: string): FileShape {
  const masked = maskCode(source);
  const describes: Block[] = [];
  const tests: Block[] = [];
  const re = /\b(test|it)((?:\.describe)?)(?:\.(only|skip|fixme|fail|slow|serial|parallel))?\s*\(/g;
  const describeRe = /\b(?:test\.)?describe(?:\.(only|skip|fixme|serial|parallel))?\s*\(/g;
  for (const match of masked.matchAll(describeRe)) {
    const open = match.index! + match[0].length - 1;
    const title = stringArgument(source, open + 1);
    const end = closingParen(masked, open);
    if (title !== undefined && end > 0) describes.push({ title, start: match.index!, end, modifier: match[1] });
  }
  for (const match of masked.matchAll(re)) {
    if (match[2]) continue; // test.describe(...) is handled above
    const before = masked.slice(Math.max(0, match.index! - 1), match.index!);
    if (before === '.') continue; // something.test(...)
    const open = match.index! + match[0].length - 1;
    const title = stringArgument(source, open + 1);
    if (title === undefined) continue; // test.skip(condition) inside a body
    const end = closingParen(masked, open);
    if (end < 0) continue;
    tests.push({ title, start: match.index!, end, modifier: match[3] });
  }

  const shapes = new Map<string, TestShape>();
  for (const block of tests) {
    const path = describes
      .filter((d) => d.start < block.start && d.end > block.end)
      .sort((a, b) => a.start - b.start)
      .map((d) => d.title);
    let key = [...path, block.title].join(' › ');
    while (shapes.has(key)) key += ' (again)';
    const body = masked.slice(block.start, block.end + 1);
    const matchers = [...body.matchAll(/\.(to[A-Z]\w*)\s*\(/g)].map((m) => m[1]);
    shapes.set(key, {
      key,
      title: block.title,
      line: lineOf(source, block.start),
      modifier: block.modifier,
      assertions: count(body, /\bexpect(?:\.soft|\.poll)?\s*\(/g),
      soft: count(body, /\bexpect\.soft\s*\(/g),
      conditionalSkips: count(body, /\btest\.(?:skip|fixme)\s*\(/g),
      hardWaits: count(body, /\.waitForTimeout\s*\(/g),
      forced: count(body, /\bforce\s*:\s*true\b/g),
      swallowed: count(body, /\.catch\s*\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*(?:\{\s*\}|undefined|null|void 0|false|true)\s*\)/g),
      tries: count(body, /\btry\s*\{/g),
      maxTimeout: maxNumber(body, /(?:\btimeout\s*:\s*|\bsetTimeout\s*\(\s*)([\d_]+)/g),
      strong: matchers.filter((m) => STRONG.has(m)).length,
      weak: matchers.filter((m) => WEAK.has(m)).length,
      body: body.replace(/\s+/g, ' '),
    });
  }
  return {
    tests: shapes,
    only: tests.filter((t) => t.modifier === 'only').length + describes.filter((d) => d.modifier === 'only').length,
    describeSkips: describes.filter((d) => d.modifier === 'skip' || d.modifier === 'fixme').length,
    maxRetries: maxNumber(masked, /\bretries\s*:\s*([\d_]+)/g),
    maxDiffAllowance: Math.max(
      maxNumber(masked, /\bmaxDiffPixels\s*:\s*([\d_]+)/g),
      maxNumber(masked, /\bmaxDiffPixelRatio\s*:\s*(0?\.\d+|\d+)/g) * 1_000_000,
      maxNumber(masked, /\bthreshold\s*:\s*(0?\.\d+|\d+)/g) * 1_000_000,
    ),
  };
}

/** Compare two versions of one file. */
export function guardFileChange(file: string, beforeSource: string, afterSource: string | undefined): GuardFileResult {
  const before = shapeOf(beforeSource);
  const findings: GuardFinding[] = [];
  if (afterSource === undefined) {
    if (before.tests.size > 0) {
      findings.push({
        severity: 'block',
        rule: 'file-deleted',
        message: `The file was deleted with its ${before.tests.size} test${before.tests.size === 1 ? '' : 's'}.`,
      });
    }
    return { file, findings, testsBefore: before.tests.size, testsAfter: 0 };
  }
  const after = shapeOf(afterSource);

  const removed = [...before.tests.values()].filter((t) => !after.tests.has(t.key));
  const added = [...after.tests.values()].filter((t) => !before.tests.has(t.key));
  const renamed = new Map<string, TestShape>();
  for (const old of removed) {
    const twin = added.find((t) => ![...renamed.values()].includes(t) && t.body.replace(/^\S+\s*\(\s*/, '') === old.body.replace(/^\S+\s*\(\s*/, ''));
    const similar =
      twin ??
      added.find(
        (t) =>
          ![...renamed.values()].includes(t) &&
          t.assertions >= old.assertions &&
          t.strong >= old.strong &&
          Math.abs(t.body.length - old.body.length) < Math.max(80, old.body.length * 0.2),
      );
    if (similar && removed.length === added.length) renamed.set(old.key, similar);
  }

  for (const old of removed) {
    const now = renamed.get(old.key);
    if (now) {
      compareTest(old, now, findings);
      continue;
    }
    findings.push({ severity: 'block', rule: 'test-removed', test: old.key, message: `Test removed (it had ${old.assertions} assertion${old.assertions === 1 ? '' : 's'}).` });
  }
  for (const [key, old] of before.tests) {
    const now = after.tests.get(key);
    if (now) compareTest(old, now, findings);
  }

  if (after.only > before.only) {
    findings.push({ severity: 'block', rule: 'only-added', message: '`.only` was added: every other test in the run is silently skipped.' });
  }
  if (after.describeSkips > before.describeSkips) {
    findings.push({ severity: 'block', rule: 'skip-added', message: 'A whole describe block was marked skip or fixme.' });
  }
  if (after.maxRetries > before.maxRetries) {
    findings.push({
      severity: 'warn',
      rule: 'retries-raised',
      message: `Retries raised from ${before.maxRetries} to ${after.maxRetries}: a flaky test passing on retry is still flaky.`,
    });
  }
  if (after.maxDiffAllowance > before.maxDiffAllowance && before.maxDiffAllowance >= 0 && after.maxDiffAllowance > 0) {
    findings.push({
      severity: 'warn',
      rule: 'screenshot-tolerance-raised',
      message: 'A screenshot comparison now tolerates more differences (maxDiffPixels, maxDiffPixelRatio or threshold went up).',
    });
  }
  return { file, findings, testsBefore: before.tests.size, testsAfter: after.tests.size };
}

function compareTest(old: TestShape, now: TestShape, findings: GuardFinding[]): void {
  const where = { test: now.key === old.key ? now.key : `${old.key} → ${now.key}`, line: now.line };
  if ((now.modifier === 'skip' || now.modifier === 'fixme') && old.modifier !== now.modifier) {
    findings.push({ severity: 'block', rule: 'skip-added', ...where, message: `Test marked \`${now.modifier}\`: it no longer runs.` });
  }
  if (now.modifier === 'fail' && old.modifier !== 'fail') {
    findings.push({ severity: 'block', rule: 'skip-added', ...where, message: 'Test marked `fail`: it now passes when it fails.' });
  }
  if (now.conditionalSkips > old.conditionalSkips) {
    findings.push({ severity: 'block', rule: 'skip-added', ...where, message: 'A `test.skip()` / `test.fixme()` call was added inside the test.' });
  }
  if (now.assertions < old.assertions) {
    findings.push({
      severity: 'block',
      rule: 'assertions-removed',
      ...where,
      message: `Assertions went from ${old.assertions} to ${now.assertions}.`,
    });
  } else if (now.soft > old.soft) {
    findings.push({
      severity: 'warn',
      rule: 'assertion-softened',
      ...where,
      message: 'A hard `expect` became `expect.soft`: the test keeps going after it fails.',
    });
  }
  if (now.strong < old.strong && now.weak > old.weak) {
    findings.push({
      severity: 'warn',
      rule: 'weaker-matcher',
      ...where,
      message: 'A specific matcher (toHaveText, toBeVisible, toEqual…) was swapped for a looser one (toBeTruthy, toBeAttached, toContainText…).',
    });
  }
  if (now.hardWaits > old.hardWaits) {
    findings.push({ severity: 'warn', rule: 'hard-wait-added', ...where, message: '`waitForTimeout` was added: it hides the race instead of waiting for the condition.' });
  }
  if (now.forced > old.forced) {
    findings.push({ severity: 'warn', rule: 'force-added', ...where, message: '`force: true` was added: the click skips the checks that catch a covered or disabled element.' });
  }
  if (now.swallowed > old.swallowed || now.tries > old.tries) {
    findings.push({ severity: 'warn', rule: 'error-swallowed', ...where, message: 'A `try` block or empty `.catch()` was added: a failing step can now pass silently.' });
  }
  if (now.maxTimeout > Math.max(old.maxTimeout * 2, 30_000)) {
    findings.push({
      severity: 'warn',
      rule: 'timeout-raised',
      ...where,
      message: `A timeout went up to ${now.maxTimeout} ms${old.maxTimeout ? ` (was ${old.maxTimeout})` : ''}: waiting longer rarely fixes the cause.`,
    });
  }
}

export function guardVerdict(results: GuardFileResult[]): GuardVerdict {
  const all = results.flatMap((r) => r.findings);
  if (all.some((f) => f.severity === 'block')) return 'BLOCK';
  if (all.length > 0) return 'WARN';
  return 'OK';
}

/** Spec files and Playwright configs, the files the guard reads. */
export function isGuardedFile(file: string): boolean {
  return /\.(spec|test)\.[cm]?[jt]sx?$/.test(file) || /(^|\/)playwright\.config\.[cm]?[jt]s$/.test(file) || /(^|\/)(e2e|tests?)\/.*\.[cm]?[jt]sx?$/.test(file);
}

/** Markdown report shared by the tool and the CLI. */
export function renderGuardReport(results: GuardFileResult[], scope: string): string {
  const verdict = guardVerdict(results);
  const findings = results.flatMap((r) => r.findings.map((f) => ({ ...f, file: r.file })));
  const blocks = findings.filter((f) => f.severity === 'block').length;
  const warns = findings.length - blocks;
  const lines: string[] = [];
  if (verdict === 'BLOCK') lines.push(`## 🛑 BLOCK — ${blocks} change${blocks === 1 ? '' : 's'} make tests check less`);
  else if (verdict === 'WARN') lines.push(`## ⚠️ WARN — ${warns} change${warns === 1 ? '' : 's'} to review`);
  else lines.push('## ✅ OK — no test was weakened');
  lines.push('', `**Compared:** ${scope} · ${results.length} file${results.length === 1 ? '' : 's'}`, '');
  if (findings.length === 0) {
    lines.push('Assertions, skips, waits, timeouts and retries are the same or stricter in every changed test.');
    return lines.join('\n');
  }
  for (const f of findings) {
    const at = f.line ? `${f.file}:${f.line}` : f.file;
    lines.push(`- ${f.severity === 'block' ? '🛑' : '⚠️'} \`${at}\`${f.test ? ` · ${f.test}` : ''} — ${f.message}`);
  }
  lines.push(
    '',
    verdict === 'BLOCK'
      ? '**What to do:** a fix that makes a test pass by checking less hides the bug it was written to catch. Restore the assertion (or the test) and fix the locator, the wait or the app instead. If removing it is intended, say so in the PR and rerun the guard with that file excluded.'
      : '**What to do:** each of these can be right, but each can also hide a real failure. Check the reason before merging.',
  );
  return lines.join('\n');
}
