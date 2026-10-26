/**
 * One-click fixes on pull requests: the `ci` command's suggest-fix
 * proposals, posted as a GitHub review whose comments are "suggested
 * changes", so a reviewer applies a fix with the Commit suggestion button.
 *
 * GitHub only accepts review comments on lines that are part of the PR's
 * diff, so a fix for a line the PR did not touch stays in the report and
 * is not posted. A comment already posted for the same fix (same file,
 * line and replacement) is not posted again on the next push.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export interface FixSuggestion {
  /** Repository-relative path, posix separators. */
  path: string;
  line: number;
  before: string;
  after: string;
  kind: 'locator' | 'expectation';
  confidence: string;
  why: string;
  /** The failing test passed with the change applied. */
  verified: boolean;
  /** Title of the test the fix is for. */
  test: string;
}

export interface PullRequestContext {
  apiUrl: string;
  repository: string;
  number: number;
  headSha: string;
  token: string;
}

export interface PostReviewResult {
  posted: FixSuggestion[];
  /** Fixes whose line is not part of the PR diff. */
  outsideDiff: FixSuggestion[];
  /** Fixes posted on an earlier run. */
  duplicates: FixSuggestion[];
  error?: string;
}

type Fetch = typeof fetch;

const MARKER = 'playwright-e2e-mcp:suggestion';

/** Stable id of one fix, hidden in its comment so a re-run can find it. */
export function suggestionId(fix: Pick<FixSuggestion, 'path' | 'line' | 'after'>): string {
  return createHash('sha256').update(`${fix.path}\u0000${fix.line}\u0000${fix.after}`).digest('hex').slice(0, 16);
}

/** Lines on the new side of a unified diff patch that GitHub accepts comments on. */
export function commentableLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines;
  let next = 0;
  for (const row of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (next === 0 || row.startsWith('\\')) continue;
    if (row.startsWith('-')) continue;
    lines.add(next);
    next += 1;
  }
  return lines;
}

export function suggestionBody(fix: FixSuggestion): string {
  const status = fix.verified
    ? 'Verified: the test passes with this change.'
    : 'Not verified yet: run the test after applying it.';
  const caution =
    fix.kind === 'expectation'
      ? '\n\n> This changes what the test expects. Apply it only if the new text is intended, not a regression.'
      : '';
  // A fence longer than any backtick run in the line keeps the block intact.
  const longest = Math.max(2, ...(fix.after.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return [
    `**playwright-e2e-mcp** · ${fix.kind === 'locator' ? 'locator fix' : 'expectation update'} for \`${fix.test}\` · confidence ${fix.confidence}`,
    '',
    `${status} ${fix.why}${caution}`,
    '',
    `${fence}suggestion`,
    fix.after,
    fence,
    '',
    `<!-- ${MARKER} ${suggestionId(fix)} -->`,
  ].join('\n');
}

/** The pull request this job runs for, from the Actions environment; undefined outside one. */
export async function pullRequestFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<PullRequestContext | undefined> {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token || !env.GITHUB_EVENT_PATH || !env.GITHUB_REPOSITORY) return undefined;
  let event: { pull_request?: { number?: number; head?: { sha?: string } } };
  try {
    event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    return undefined;
  }
  const pr = event.pull_request;
  if (!pr?.number || !pr.head?.sha) return undefined;
  return {
    apiUrl: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''),
    repository: env.GITHUB_REPOSITORY,
    number: pr.number,
    headSha: pr.head.sha,
    token,
  };
}

async function github(fetchImpl: Fetch, pr: PullRequestContext, method: string, route: string, body?: unknown): Promise<unknown> {
  const response = await fetchImpl(`${pr.apiUrl}/repos/${pr.repository}${route}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${pr.token}`,
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`GitHub ${method} ${route} answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return response.status === 204 ? undefined : response.json();
}

/** Every page of a list endpoint (100 per page, at most 30 pages). */
async function listAll<T>(fetchImpl: Fetch, pr: PullRequestContext, route: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= 30; page += 1) {
    const batch = (await github(fetchImpl, pr, 'GET', `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`)) as T[];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/** Post the fixes as one review of suggested changes. Never throws: failures come back in `error`. */
export async function postSuggestionReview(
  fixes: FixSuggestion[],
  pr: PullRequestContext,
  fetchImpl: Fetch = fetch,
): Promise<PostReviewResult> {
  const result: PostReviewResult = { posted: [], outsideDiff: [], duplicates: [] };
  if (fixes.length === 0) return result;
  try {
    const files = await listAll<{ filename: string; patch?: string }>(fetchImpl, pr, `/pulls/${pr.number}/files`);
    const diffLines = new Map(files.map((file) => [file.filename, commentableLines(file.patch)]));
    const existing = await listAll<{ body?: string }>(fetchImpl, pr, `/pulls/${pr.number}/comments`);
    const postedIds = new Set(
      existing.flatMap((comment) => [...(comment.body ?? '').matchAll(new RegExp(`${MARKER} ([0-9a-f]{16})`, 'g'))].map((m) => m[1])),
    );

    const comments: Array<{ path: string; line: number; side: 'RIGHT'; body: string }> = [];
    for (const fix of fixes) {
      if (!diffLines.get(fix.path)?.has(fix.line)) result.outsideDiff.push(fix);
      else if (postedIds.has(suggestionId(fix))) result.duplicates.push(fix);
      else {
        comments.push({ path: fix.path, line: fix.line, side: 'RIGHT', body: suggestionBody(fix) });
        result.posted.push(fix);
      }
    }
    if (comments.length > 0) {
      await github(fetchImpl, pr, 'POST', `/pulls/${pr.number}/reviews`, {
        commit_id: pr.headSha,
        event: 'COMMENT',
        body: `playwright-e2e-mcp found ${comments.length === 1 ? 'a fix' : `${comments.length} fixes`} for failing tests. Use **Commit suggestion** to apply ${comments.length === 1 ? 'it' : 'one'}.`,
        comments,
      });
    }
  } catch (err) {
    result.error = (err as Error).message;
    result.posted = [];
  }
  return result;
}
