/**
 * Tool — bisect-failure: find the commit that broke a test. It checks the
 * project out at commits between a good and a bad one in a temporary git
 * worktree (the caller's checkout is never touched), runs the test there,
 * and binary-searches to the first commit where it fails, then reports
 * that commit, what it changed and how the test failed.
 */

import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { PlaywrightMcpError } from '../types/index.js';
import type { RunTestResult, ToolContext, ToolResponse } from '../types/index.js';
import { bisectCommits } from '../utils/bisect.js';
import type { BisectStep, BisectVerdict } from '../utils/bisect.js';
import { normalizePath, relativeToRoot, toNativePath } from '../utils/path-utils.js';
import { runTests } from '../utils/playwright-runner.js';
import { detectProject } from '../utils/project-detector.js';
import { localGitInfo, readHistory } from '../utils/run-history.js';
import {
  clipLines,
  codeFence,
  formatDuration,
  guard,
  resolveConfigSelection,
  resolveProjectRoot,
  sanitizeTestPathArgument,
  toolText,
} from './shared.js';

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

const bisectInput = z.object({
  projectRoot: z.string().optional().describe('Project directory (inside a git repository); defaults to the server working directory'),
  test: z.string().min(1).describe('The failing spec file, e.g. "tests/cart.spec.ts" (a :line suffix also works, but lines move between commits; prefer grep)'),
  grep: z.string().optional().describe('Test title (or part of it) to run inside the file; keeps the search on one test'),
  project: z.string().optional().describe('Playwright project name to run in'),
  good: z
    .string()
    .optional()
    .describe('A commit or ref where the test passed. Defaults to the newest commit in the run history where it passed'),
  bad: z.string().optional().describe('A commit or ref where it fails (default HEAD)'),
  repeat: z.number().int().min(1).max(10).optional().describe('Run the test this many times per commit; any failure marks the commit bad (default 1; raise it for a flaky failure)'),
  maxSteps: z.number().int().min(1).max(30).optional().describe('Most commits to test besides the two ends (default 12, enough for 4,000 commits)'),
  stepTimeoutMs: z.number().int().min(5_000).max(1_800_000).optional().describe('Time limit for each test run (default 180000)'),
  config: z.string().optional().describe('playwright.config path or 1-based index'),
});

export type BisectFailureInput = z.infer<typeof bisectInput>;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string, timeout = 60_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: toNativePath(cwd), timeout, windowsHide: true, maxBuffer: 20_000_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout).trim(), stderr: String(stderr).trim() });
    });
  });
}

/** A ref the caller passed, checked before it reaches git (no options, no odd characters). */
export function checkRef(ref: string, label: string): string {
  const value = ref.trim();
  if (value === '' || value.startsWith('-') || !/^[\w./^~@{}-]+$/.test(value) || value.includes('..')) {
    throw new PlaywrightMcpError(`${label} "${ref}" is not a commit or ref`, 'INVALID_PATH', {
      hint: 'Pass a commit hash, a branch, a tag or a form like HEAD~20.',
    });
  }
  return value;
}

async function resolveCommit(ref: string, cwd: string, label: string): Promise<string> {
  const result = await git(['rev-parse', '--verify', '--quiet', `${checkRef(ref, label)}^{commit}`], cwd);
  if (result.code !== 0 || !/^[0-9a-f]{40,64}$/.test(result.stdout)) {
    throw new PlaywrightMcpError(`${label} "${ref}" is not a commit in this repository`, 'INVALID_PATH', {
      hint: 'Check the hash or ref with git log.',
    });
  }
  return result.stdout;
}

function short(sha: string): string {
  return sha.slice(0, 8);
}

/** First line of the first failure, for the steps table. */
function failureNote(result: RunTestResult): string | undefined {
  const first = result.failures[0];
  if (!first) return result.errorMessage?.split('\n')[0];
  return `${first.title}: ${(first.message ?? '').split('\n').find((l) => l.trim() !== '') ?? first.failureKind}`.slice(0, 200);
}

export const bisectFailureTool = {
  name: 'bisect-failure',
  description:
    'Find the commit that broke a test: binary-search the git history between a good and a bad commit, running the test at each step in a temporary worktree (your checkout is untouched), and report the first bad commit with its diff summary and failure. good defaults to the newest commit where the run history saw the test pass.',
  inputSchema: bisectInput,
  handler: async (args: BisectFailureInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('bisect-failure', async () => {
      if (ctx.restricted) {
        throw new PlaywrightMcpError('bisect-failure is not available on this server', 'INVALID_PATH', {
          hint: 'It runs your test code at old commits; use a local install.',
        });
      }
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      const top = await git(['rev-parse', '--show-toplevel'], root);
      if (top.code !== 0) {
        throw new PlaywrightMcpError('The project is not inside a git repository', 'INVALID_PATH', {
          hint: 'bisect-failure searches git history; initialise or clone the repository first.',
        });
      }
      const repoTop = normalizePath(realpathSync(top.stdout));
      const subdir = path.posix.relative(repoTop, normalizePath(realpathSync(toNativePath(root))));
      const testArg = sanitizeTestPathArgument(args.test, root);
      const lineMatch = /:(\d+)$/.exec(testArg);
      const testRel = relativeToRoot(root, lineMatch ? testArg.slice(0, -lineMatch[0].length) : testArg);
      const testTarget = `${testRel}${lineMatch ? lineMatch[0] : ''}`;

      const bad = await resolveCommit(args.bad ?? 'HEAD', root, 'bad');
      let good: string;
      let goodFrom = '';
      if (args.good) {
        good = await resolveCommit(args.good, root, 'good');
      } else {
        // The newest recorded run, at a clean commit, where this file's tests passed.
        const history = await readHistory(root, 1_000).catch(() => []);
        const wanted = args.grep?.toLowerCase();
        let found: string | undefined;
        for (const entry of [...history].reverse()) {
          if (!entry.commit || entry.dirty || entry.commit === bad) continue;
          const mine = entry.tests.filter(
            (t) => (testRel.endsWith(t.file) || t.file.endsWith(testRel)) && (!wanted || t.title.toLowerCase().includes(wanted)),
          );
          if (mine.length > 0 && mine.every((t) => t.status === 'passed' || t.status === 'skipped')) {
            if ((await git(['merge-base', '--is-ancestor', entry.commit, bad], root)).code === 0) {
              found = entry.commit;
              break;
            }
          }
        }
        if (!found) {
          throw new PlaywrightMcpError('No good commit given, and the run history has no passing run of this test at an earlier commit', 'INVALID_PATH', {
            hint: 'Pass good: a commit, tag or ref where the test passed (e.g. the last release tag, or HEAD~20).',
          });
        }
        good = found;
        goodFrom = ' (from the run history)';
      }
      if (good === bad) throw new PlaywrightMcpError('good and bad are the same commit', 'INVALID_PATH', { hint: 'Pass an older good commit.' });
      if ((await git(['merge-base', '--is-ancestor', good, bad], root)).code !== 0) {
        throw new PlaywrightMcpError(`good ${short(good)} is not an ancestor of bad ${short(bad)}`, 'INVALID_PATH', {
          hint: 'Pick a good commit from the history of the bad one (git log bad).',
        });
      }
      const list = await git(['rev-list', '--first-parent', '--reverse', `${good}..${bad}`], root);
      const commits = list.stdout.split('\n').filter((c) => /^[0-9a-f]{40,64}$/.test(c));
      if (commits.length === 0) throw new PlaywrightMcpError('No commits between good and bad', 'INVALID_PATH');

      const detection = await detectProject(root);
      const configAbs = resolveConfigSelection(detection, args.config);
      const configRel = configAbs ? relativeToRoot(root, configAbs) : undefined;
      const lockAtHead = new Map<string, string>();
      for (const name of LOCKFILES) {
        const blob = await git(['rev-parse', `HEAD:${subdir ? `${subdir}/` : ''}${name}`], root);
        if (blob.code === 0) lockAtHead.set(name, blob.stdout);
      }

      const tmp = await mkdtemp(path.join(os.tmpdir(), 'pw-bisect-'));
      const worktree = path.join(tmp, 'wt');
      const added = await git(['worktree', 'add', '--detach', worktree, bad], root, 120_000);
      if (added.code !== 0) {
        await rm(tmp, { recursive: true, force: true });
        throw new PlaywrightMcpError('Could not create a temporary git worktree', 'INVALID_PATH', { details: added.stderr });
      }
      const projectDir = subdir ? path.join(worktree, ...subdir.split('/')) : worktree;
      const started = Date.now();
      const runs = new Map<string, RunTestResult>();
      const depsChanged = new Set<string>();

      const check = async (commit: string): Promise<{ verdict: BisectVerdict; note?: string }> => {
        const out = await git(['checkout', '--detach', '--force', '--quiet', commit], worktree, 120_000);
        if (out.code !== 0) return { verdict: 'skip', note: `checkout failed: ${out.stderr.split('\n')[0]}` };
        await git(['clean', '-fdq'], worktree);
        if (!existsSync(path.join(projectDir, ...testRel.split('/')))) return { verdict: 'skip', note: 'the test file does not exist at this commit' };
        // Reuse the installed dependencies rather than installing per commit.
        for (const [from, to] of [
          [path.join(toNativePath(root), 'node_modules'), path.join(projectDir, 'node_modules')],
          [path.join(repoTop, 'node_modules'), path.join(worktree, 'node_modules')],
        ]) {
          if (existsSync(from) && !existsSync(to)) await symlink(from, to, process.platform === 'win32' ? 'junction' : 'dir').catch(() => undefined);
        }
        for (const [name, blob] of lockAtHead) {
          const then = await git(['rev-parse', `${commit}:${subdir ? `${subdir}/` : ''}${name}`], worktree);
          if (then.code === 0 && then.stdout !== blob) depsChanged.add(commit);
        }
        let result: RunTestResult;
        try {
          result = await runTests({
            projectRoot: normalizePath(projectDir),
            configPath: configRel ? normalizePath(path.join(projectDir, ...configRel.split('/'))) : undefined,
            testFiles: [testTarget],
            grep: args.grep,
            project: args.project,
            repeatEach: args.repeat && args.repeat > 1 ? args.repeat : undefined,
            retries: 0,
            retryOnFailure: false,
            timeoutMs: args.stepTimeoutMs ?? 180_000,
            signal: ctx.signal,
          });
        } catch (err) {
          if (ctx.signal?.aborted) throw err;
          return { verdict: 'skip', note: `could not run: ${(err as Error).message.split('\n')[0]}` };
        }
        runs.set(commit, result);
        const ran = (result.outcomes ?? []).filter((o) => o.status !== 'skipped').length;
        if (result.failures.length > 0 && !result.timedOut) return { verdict: 'bad', note: failureNote(result) };
        if (result.ok && ran > 0) return { verdict: 'good' };
        return { verdict: 'skip', note: result.timedOut ? 'the run hit stepTimeoutMs' : (failureNote(result) ?? 'no test matched at this commit') };
      };

      try {
        const out: string[] = [];
        // Both ends first: a search between two passing (or two failing) commits finds nothing.
        const atBad = await check(bad);
        if (atBad.verdict !== 'bad') {
          return toolText(
            [
              `## ⚠️ The test does not fail at ${short(bad)}`,
              '',
              atBad.verdict === 'good' ? 'It passed there, so there is nothing to search for.' : `It could not be tested there: ${atBad.note}.`,
              '',
              '> Check `test`/`grep`, or pass `bad` (a commit where it fails). For a flaky failure, raise `repeat`.',
            ].join('\n'),
            { ok: false, status: 'not-failing' },
          );
        }
        const atGood = await check(good);
        if (atGood.verdict !== 'good') {
          return toolText(
            [
              `## ⚠️ The test does not pass at the good commit ${short(good)}${goodFrom}`,
              '',
              atGood.verdict === 'bad' ? `It fails there too: ${atGood.note}` : `It could not be tested there: ${atGood.note}.`,
              '',
              '> Pass an older `good` commit where the test passed.',
            ].join('\n'),
            { ok: false, status: 'good-fails' },
          );
        }

        const search = await bisectCommits(commits, check, { maxSteps: args.maxSteps ?? 12, signal: ctx.signal });
        const steps: BisectStep[] = [
          { commit: good, verdict: 'good' },
          { commit: bad, verdict: 'bad', ...(atBad.note ? { note: atBad.note } : {}) },
          ...search.steps,
        ];
        const subjects = new Map<string, string>();
        for (const step of steps) {
          const s = await git(['show', '-s', '--format=%s', step.commit], root);
          subjects.set(step.commit, s.stdout.slice(0, 80));
        }

        let firstBadData: { sha: string; subject: string; author: string; date: string; files: string[] } | undefined;
        if (search.firstBad) {
          const sha = search.firstBad;
          const meta = (await git(['show', '-s', '--format=%H%x1f%an%x1f%aI%x1f%s', sha], root)).stdout.split('\x1f');
          const files = (await git(['show', '--format=', '--name-only', sha], root)).stdout.split('\n').filter(Boolean);
          const stat = (await git(['show', '--format=', '--stat=100', sha], root)).stdout;
          firstBadData = { sha, author: meta[1] ?? '', date: meta[2] ?? '', subject: meta[3] ?? '', files: files.slice(0, 50) };
          out.push(
            `## 🎯 First bad commit: \`${short(sha)}\` ${firstBadData.subject}`,
            '',
            `**Author:** ${firstBadData.author}  |  **Date:** ${firstBadData.date}  |  **Searched:** ${commits.length} commit${commits.length === 1 ? '' : 's'} in ${search.steps.length + 2} runs, ${formatDuration(Date.now() - started)}`,
            '',
            codeFence(clipLines(stat, 25, 3_000), 'text'),
          );
          const run = runs.get(sha);
          const first = run?.failures[0];
          if (first) {
            out.push('', `**How it fails there:** ${first.title}`, '', codeFence(clipLines(first.message ?? '', 10, 1_500), 'text'));
          }
          if (depsChanged.has(sha)) {
            out.push('', '> ⚠️ Dependencies changed in this range (lockfile differs from HEAD), and every step ran with your installed node_modules. If the commit only bumps a package, that is likely the cause.');
          }
          out.push('', `> Next: \`git show ${short(sha)}${subdir ? ` -- ${subdir}` : ''}\` to read the change, or **get-failure** after a run-test at HEAD.`);
        } else {
          out.push(
            `## 🔎 Narrowed to ${search.range.length} commits`,
            '',
            search.stopped === 'max-steps'
              ? `The search stopped at maxSteps (${args.maxSteps ?? 12}). Raise it, or pass the newest commit below as good.`
              : search.stopped === 'cancelled'
                ? 'The search was cancelled.'
                : 'The commits between could not be tested (see the steps), so the first bad commit is one of these:',
            '',
            ...search.range.slice(0, 20).map((c) => `- \`${short(c)}\``),
          );
        }

        out.push('', '### Steps', '', '| Commit | Result | Subject | Note |', '|---|---|---|---|');
        for (const step of steps) {
          const icon = step.verdict === 'good' ? '✅ good' : step.verdict === 'bad' ? '❌ bad' : '⏭️ skip';
          out.push(`| \`${short(step.commit)}\` | ${icon} | ${(subjects.get(step.commit) ?? '').replace(/\|/g, '\\|')} | ${(step.note ?? '').replace(/\|/g, '\\|').slice(0, 120)} |`);
        }
        const info = bad === (await resolveCommit('HEAD', root, 'HEAD')) ? await localGitInfo(root) : undefined;
        if (info?.dirty) out.push('', '> Your uncommitted changes were not part of the search: it tested committed code only.');

        ctx.logger.info('bisect-failure finished', { commits: commits.length, steps: steps.length, found: Boolean(search.firstBad) });
        return toolText(out.join('\n'), {
          ok: true,
          status: search.firstBad ? 'found' : (search.stopped ?? 'ambiguous'),
          ...(firstBadData ? { firstBad: firstBadData } : {}),
          steps: steps.map((s) => ({ commit: s.commit, verdict: s.verdict, ...(s.note ? { note: s.note } : {}) })),
        });
      } finally {
        await git(['worktree', 'remove', '--force', worktree], root, 120_000);
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
        await git(['worktree', 'prune'], root);
      }
    }),
};
