/**
 * bisect-failure: the binary search finds the first bad commit, steps
 * around commits it cannot test, and stops at maxSteps; the tool runs a
 * real Playwright test across a real git history in a temporary worktree
 * and leaves the caller's checkout as it was.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bisectCommits } from '../dist/utils/bisect.js';
import { bisectFailureTool, checkRef } from '../dist/tools/bisect-failure.js';
import { createToolStore } from '../dist/tools/shared.js';
import { logger } from '../dist/utils/logger.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** commits c0..c(n-1); the ones in `bad` fail, the ones in `skip` cannot be tested. */
function fakeCheck(firstBad, skip = new Set()) {
  const asked = [];
  const check = async (commit) => {
    asked.push(commit);
    if (skip.has(commit)) return { verdict: 'skip', note: 'missing' };
    return Number(commit.slice(1)) >= firstBad ? { verdict: 'bad', note: 'boom' } : { verdict: 'good' };
  };
  return { check, asked };
}

const commits = Array.from({ length: 16 }, (_, i) => `c${i}`);

test('bisectCommits finds the first bad commit in log2(n) steps', async () => {
  for (const firstBad of [0, 1, 7, 15]) {
    const { check, asked } = fakeCheck(firstBad);
    const outcome = await bisectCommits(commits, check);
    assert.equal(outcome.firstBad, `c${firstBad}`, `first bad c${firstBad}`);
    assert.ok(asked.length <= 4, `${asked.length} steps`);
  }
});

test('bisectCommits steps around untestable commits, and reports a range when it must', async () => {
  const around = await bisectCommits(commits, fakeCheck(9, new Set(['c7'])).check);
  assert.equal(around.firstBad, 'c9');
  assert.ok(around.steps.some((s) => s.verdict === 'skip'));

  const blocked = await bisectCommits(commits, fakeCheck(9, new Set(['c8'])).check);
  assert.equal(blocked.firstBad, undefined);
  assert.deepEqual(blocked.range, ['c8', 'c9']);

  const capped = await bisectCommits(commits, fakeCheck(9).check, { maxSteps: 1 });
  assert.equal(capped.stopped, 'max-steps');
  assert.ok(capped.range.length > 1);
});

test('checkRef refuses options and ranges', () => {
  assert.equal(checkRef(' HEAD~3 ', 'good'), 'HEAD~3');
  assert.equal(checkRef('v0.5.1', 'good'), 'v0.5.1');
  for (const bad of ['--output=/tmp/x', 'a..b', 'a b', '$(id)', '']) assert.throws(() => checkRef(bad, 'good'), /not a commit or ref/);
});

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('bisect-failure finds the commit that broke a real test, in a worktree', { skip: !gitAvailable() && 'git not installed', timeout: 180_000 }, async () => {
  // The project sits in a subfolder of the repository, as in a monorepo.
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pw-bisect-test-')));
  const root = path.join(repo, 'app');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  try {
    mkdirSync(root);
    symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'junction');
    writeFileSync(path.join(root, '.gitignore'), 'node_modules\ntest-results\n.playwright-e2e-mcp\n');
    writeFileSync(path.join(root, 'package.json'), '{ "name": "bisect-fixture", "private": true }\n');
    writeFileSync(path.join(root, 'playwright.config.ts'), "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', reporter: 'list' });\n");
    mkdirSync(path.join(root, 'tests'));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'price.ts'), 'export const price = 42;\n');
    writeFileSync(
      path.join(root, 'tests', 'price.spec.ts'),
      "import { test, expect } from '@playwright/test';\nimport { price } from '../src/price';\ntest('price is 42', () => {\n  expect(price).toBe(42);\n});\n",
    );
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'Add price');
    const good = git('rev-parse', 'HEAD');
    const commit = (file, text, message) => {
      writeFileSync(path.join(root, file), text);
      git('add', '-A');
      git('commit', '-q', '-m', message);
      return git('rev-parse', 'HEAD');
    };
    commit('README.md', 'one\n', 'Docs one');
    commit('README.md', 'two\n', 'Docs two');
    const breaking = commit('src/price.ts', 'export const price = 41;\n', 'Round the price down');
    commit('README.md', 'three\n', 'Docs three');
    commit('README.md', 'four\n', 'Docs four');
    // Local edits must survive the search.
    writeFileSync(path.join(root, 'README.md'), 'local edit\n');

    const ctx = { logger: logger.child({ tool: 'test' }), store: createToolStore(), projectRoot: root };
    const result = await bisectFailureTool.handler({ test: 'tests/price.spec.ts', good }, ctx);
    const text = result.content[0].text;
    assert.equal(result.isError, undefined, text);
    assert.equal(result.structuredContent.status, 'found', text);
    assert.equal(result.structuredContent.firstBad.sha, breaking);
    assert.match(text, /First bad commit: `[0-9a-f]{8}` Round the price down/);
    assert.match(text, /Expected: 42/);
    assert.match(text, /uncommitted changes were not part of the search/);
    assert.equal(readFileSync(path.join(root, 'README.md'), 'utf8'), 'local edit\n');
    assert.equal(git('worktree', 'list').split('\n').length, 1, 'the temporary worktree is removed');

    const passing = await bisectFailureTool.handler({ test: 'tests/price.spec.ts', good, bad: good }, ctx);
    assert.match(passing.content[0].text, /same commit/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  assert.ok(!existsSync(repo));
});
