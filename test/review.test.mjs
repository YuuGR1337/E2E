/**
 * One-click fixes on pull requests: the ci command posts suggest-fix
 * proposals as GitHub suggested changes. These tests drive the posting
 * against a fake GitHub API: only lines inside the PR diff are posted,
 * fixes posted on an earlier push are not posted again, and an API error
 * is reported, never thrown.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCiArgs, repoPath } from '../dist/cli/ci.js';
import { commentableLines, postSuggestionReview, pullRequestFromEnv, suggestionBody, suggestionId } from '../dist/cli/review.js';

const PR = { apiUrl: 'https://api.example', repository: 'acme/shop', number: 7, headSha: 'abc123', token: 't0ken' };

function fix(overrides = {}) {
  return {
    path: 'tests/cart.spec.ts',
    line: 12,
    before: "  await page.getByTestId('buy').click();",
    after: "  await page.getByRole('button', { name: 'Buy now' }).click();",
    kind: 'locator',
    confidence: 'high',
    why: 'The test id was removed; the role locator matches one element.',
    verified: true,
    test: 'cart › buys',
    ...overrides,
  };
}

/** A fake GitHub: answers the files and comments lists, records every request. */
function fakeGitHub({ files, comments = [], reviewStatus = 200 }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('/pulls/7/files')) return json(200, files);
    if (url.includes('/pulls/7/comments')) return json(200, comments);
    if (url.endsWith('/pulls/7/reviews')) return json(reviewStatus, reviewStatus === 200 ? { id: 1 } : { message: 'Resource not accessible by integration' });
    return json(404, {});
  };
  return { calls, fetchImpl };
}

test('commentableLines maps hunks to new-file lines, skipping removed ones', () => {
  const patch = ['@@ -10,4 +10,5 @@ test', ' context 10', '-removed', '+added 11', '+added 12', ' context 13', '\\ No newline at end of file', '@@ -40 +41 @@', '+x'].join('\n');
  assert.deepEqual([...commentableLines(patch)], [10, 11, 12, 13, 41]);
  assert.equal(commentableLines(undefined).size, 0);
});

test('a suggestion body carries the replacement line, the status and a hidden id', () => {
  const body = suggestionBody(fix());
  assert.match(body, /```suggestion\n {2}await page\.getByRole\('button', \{ name: 'Buy now' \}\)\.click\(\);\n```/);
  assert.match(body, /Verified: the test passes/);
  assert.ok(body.includes(`playwright-e2e-mcp:suggestion ${suggestionId(fix())}`));
  const expectation = suggestionBody(fix({ kind: 'expectation', verified: false }));
  assert.match(expectation, /changes what the test expects/);
  assert.match(expectation, /Not verified yet/);
  // Backticks in the line get a longer fence.
  assert.match(suggestionBody(fix({ after: 'const s = ```x```;' })), /````suggestion\nconst s = ```x```;\n````/);
});

test('only fixes on diff lines are posted, as one review on the head commit', async () => {
  const { calls, fetchImpl } = fakeGitHub({
    files: [{ filename: 'tests/cart.spec.ts', patch: '@@ -10,3 +10,4 @@\n a\n b\n+c\n d' }],
  });
  const inDiff = fix();
  const outside = fix({ line: 99, after: 'other' });
  const result = await postSuggestionReview([inDiff, outside], PR, fetchImpl);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.posted, [inDiff]);
  assert.deepEqual(result.outsideDiff, [outside]);
  const review = calls.find((c) => c.method === 'POST');
  assert.equal(review.url, 'https://api.example/repos/acme/shop/pulls/7/reviews');
  assert.equal(review.headers.authorization, 'Bearer t0ken');
  assert.equal(review.body.commit_id, 'abc123');
  assert.equal(review.body.event, 'COMMENT');
  assert.deepEqual(
    review.body.comments.map((c) => [c.path, c.line, c.side]),
    [['tests/cart.spec.ts', 12, 'RIGHT']],
  );
});

test('a fix posted on an earlier push is not posted again', async () => {
  const { calls, fetchImpl } = fakeGitHub({
    files: [{ filename: 'tests/cart.spec.ts', patch: '@@ -10,3 +10,4 @@\n a\n b\n+c\n d' }],
    comments: [{ body: suggestionBody(fix()) }],
  });
  const result = await postSuggestionReview([fix()], PR, fetchImpl);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.posted.length, 0);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('an API error is reported, not thrown', async () => {
  const { fetchImpl } = fakeGitHub({
    files: [{ filename: 'tests/cart.spec.ts', patch: '@@ -10,3 +10,4 @@\n a\n b\n+c\n d' }],
    reviewStatus: 403,
  });
  const result = await postSuggestionReview([fix()], PR, fetchImpl);
  assert.match(result.error, /403/);
  assert.equal(result.posted.length, 0);
});

test('the pull request is read from the Actions environment', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pw-review-'));
  try {
    const eventPath = path.join(dir, 'event.json');
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7, head: { sha: 'abc123' } } }));
    const env = { GITHUB_TOKEN: 't0ken', GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: 'acme/shop' };
    assert.deepEqual(await pullRequestFromEnv(env), { ...PR, apiUrl: 'https://api.github.com' });
    assert.equal(await pullRequestFromEnv({ ...env, GITHUB_TOKEN: '' }), undefined);
    writeFileSync(eventPath, JSON.stringify({ push: {} }));
    assert.equal(await pullRequestFromEnv(env), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci reads the review flags and maps paths into the repository', () => {
  const options = parseCiArgs(['--verify-fixes', '--review', '--suggestions', 'fixes.json']);
  assert.equal(options.verifyFixes, true);
  assert.equal(options.review, true);
  assert.equal(options.suggestions, 'fixes.json');
  assert.equal(parseCiArgs([]).review, false);
  const repo = path.resolve('/repo');
  assert.equal(repoPath(path.join(repo, 'web'), 'tests/a.spec.ts', repo), 'web/tests/a.spec.ts');
  assert.equal(repoPath(path.resolve('/elsewhere'), 'tests/a.spec.ts', repo), undefined);
});
