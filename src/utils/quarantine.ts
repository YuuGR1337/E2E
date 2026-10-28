/**
 * Flaky-test quarantine: a short, owned, expiring list of tests whose
 * failures do not block the build while someone fixes them.
 *
 * Retries hide flaky tests (they pass on the second try and show green);
 * skipping them hides them for good. A quarantine entry is the honest
 * middle: the test still runs and its result is still reported, but a
 * failure does not fail the run, and every entry names who owns the fix,
 * why it is there and the date it stops counting. After that date the
 * test blocks again, so quarantine cannot become a graveyard.
 *
 * The list lives in playwright-quarantine.json at the project root, meant
 * to be committed so the whole team and CI share it (the history folder is
 * git-ignored, so it does not go there).
 */

import { readFile } from 'node:fs/promises';
import { PlaywrightMcpError } from '../types/index.js';
import type { TestFailure } from '../types/index.js';
import { assertRealPathInside, joinProjectPath, toNativePath, writeFileInsideRoot } from './path-utils.js';

export const QUARANTINE_FILE = 'playwright-quarantine.json';
export const DEFAULT_QUARANTINE_DAYS = 14;
export const MAX_QUARANTINE_DAYS = 90;

export interface QuarantineEntry {
  /** Project-relative spec file, posix separators. */
  file: string;
  /** Test title, or its tail (the last parts of "describe › title"). */
  title: string;
  owner: string;
  reason: string;
  /** Last day the entry counts, YYYY-MM-DD (inclusive, UTC). */
  until: string;
  /** Day it was added, YYYY-MM-DD. */
  added: string;
}

export interface QuarantineList {
  version: 1;
  entries: QuarantineEntry[];
}

export function quarantinePath(root: string): string {
  return joinProjectPath(root, QUARANTINE_FILE);
}

export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return today(date);
}

export function isExpired(entry: QuarantineEntry, now: Date = new Date()): boolean {
  return entry.until < today(now);
}

/** Read the list; a missing file is an empty list. */
export async function readQuarantine(root: string): Promise<QuarantineList> {
  const file = quarantinePath(root);
  const text = await readFile(toNativePath(file), 'utf8').catch(() => undefined);
  if (text === undefined) return { version: 1, entries: [] };
  await assertRealPathInside(file, root);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PlaywrightMcpError(`${QUARANTINE_FILE} is not valid JSON`, 'INVALID_INPUT', {
      hint: 'Fix or delete the file; quarantine add recreates it.',
    });
  }
  const raw = (parsed as { entries?: unknown }).entries;
  const entries = Array.isArray(raw)
    ? raw.filter(
        (e): e is QuarantineEntry =>
          !!e &&
          typeof e === 'object' &&
          typeof (e as QuarantineEntry).file === 'string' &&
          typeof (e as QuarantineEntry).title === 'string' &&
          typeof (e as QuarantineEntry).until === 'string',
      )
    : [];
  return { version: 1, entries };
}

export async function writeQuarantine(root: string, list: QuarantineList): Promise<void> {
  const sorted = [...list.entries].sort((a, b) => a.file.localeCompare(b.file) || a.title.localeCompare(b.title));
  await writeFileInsideRoot(quarantinePath(root), `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`, root);
}

/** Does an entry cover this test? Titles match whole, or as the tail of the title path. */
export function matchesEntry(entry: QuarantineEntry, test: { file: string; title: string }): boolean {
  if (entry.file !== test.file) return false;
  return test.title === entry.title || test.title.endsWith(` › ${entry.title}`);
}

export interface QuarantineSplit {
  /** Failures that still fail the run. */
  blocking: TestFailure[];
  /** Failures covered by an active entry. */
  quarantined: Array<{ failure: TestFailure; entry: QuarantineEntry }>;
  /** Failures whose entry expired: they block, with a reason. */
  expired: Array<{ failure: TestFailure; entry: QuarantineEntry }>;
}

export function splitFailures(failures: TestFailure[], list: QuarantineList, now: Date = new Date()): QuarantineSplit {
  const split: QuarantineSplit = { blocking: [], quarantined: [], expired: [] };
  for (const failure of failures) {
    const entry = list.entries.find((e) => matchesEntry(e, failure));
    if (!entry) split.blocking.push(failure);
    else if (isExpired(entry, now)) {
      split.expired.push({ failure, entry });
      split.blocking.push(failure);
    } else split.quarantined.push({ failure, entry });
  }
  return split;
}

/** Markdown lines for a run's quarantine section; empty when nothing matched. */
export function quarantineLines(split: QuarantineSplit): string[] {
  const lines: string[] = [];
  if (split.quarantined.length > 0) {
    lines.push(`### 🧊 ${split.quarantined.length} quarantined failure(s), not blocking`, '');
    for (const { failure, entry } of split.quarantined) {
      lines.push(`- \`${failure.file}\` · ${failure.title} — owner **${entry.owner}**, until ${entry.until}: ${entry.reason}`);
    }
    lines.push('');
  }
  if (split.expired.length > 0) {
    lines.push(`### ⏰ ${split.expired.length} quarantine(s) expired: these failures block again`, '');
    for (const { failure, entry } of split.expired) {
      lines.push(`- \`${failure.file}\` · ${failure.title} — owner **${entry.owner}**, expired ${entry.until}. Fix it, or extend it with **quarantine** and a new reason.`);
    }
    lines.push('');
  }
  return lines;
}
