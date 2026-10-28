/**
 * Tool — check-test-change (heal guard): before a test fix is kept, check
 * it did not make the test pass by checking less. Compares changed spec
 * files with a git ref (default HEAD, i.e. the uncommitted changes), or a
 * proposed new version of one file with what is on disk, and blocks
 * deleted assertions, skipped or removed tests and `.only`; warns on
 * weaker matchers, hard waits, forced clicks, swallowed errors and raised
 * timeouts or retries.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { PlaywrightMcpError } from '../types/index.js';
import type { ToolContext, ToolResponse } from '../types/index.js';
import { joinProjectPath, relativeToRoot, sanitizeUserPath, toNativePath } from '../utils/path-utils.js';
import { guardFileChange, guardVerdict, isGuardedFile, renderGuardReport } from '../utils/test-change-guard.js';
import type { GuardFileResult } from '../utils/test-change-guard.js';
import { guard, resolveProjectRoot, toolText } from './shared.js';

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 200;

const checkTestChangeInput = z.object({
  base: z
    .string()
    .optional()
    .describe("Git ref to compare with: 'HEAD' (default: uncommitted changes), 'origin/main' (the whole branch)"),
  files: z.array(z.string()).max(MAX_FILES).optional().describe('Only these files (default: every changed spec file and playwright config)'),
  file: z.string().optional().describe('With after: the spec file a fix would change'),
  after: z.string().max(MAX_FILE_BYTES).optional().describe("With file: the fix's full new file content, checked before it is written"),
  projectRoot: z.string().optional().describe('Project directory (default: server root)'),
});

export type CheckTestChangeInput = z.infer<typeof checkTestChangeInput>;
export const checkTestChangeSchema = checkTestChangeInput;

/** Refs we hand to git: no options, no shell metacharacters. */
export function assertGitRef(ref: string): string {
  const trimmed = ref.trim();
  if (!/^[\w./~^@{}-]{1,200}$/.test(trimmed) || trimmed.startsWith('-') || trimmed.includes('..')) {
    throw new PlaywrightMcpError(`Not a git ref: ${ref}`, 'INVALID_INPUT', { hint: "Use a branch, tag or commit, e.g. 'HEAD' or 'origin/main'." });
  }
  return trimmed;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: toNativePath(root), maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function readIfExists(file: string): Promise<string | undefined> {
  return readFile(toNativePath(file), 'utf8').catch(() => undefined);
}

/** Compare every changed guarded file in the working tree with `base`. */
export async function guardAgainstRef(root: string, base: string, only?: string[]): Promise<GuardFileResult[]> {
  let top: string;
  try {
    top = (await git(root, ['rev-parse', '--show-toplevel'])).trim().replace(/\\/g, '/');
  } catch {
    throw new PlaywrightMcpError('Not a git repository', 'INVALID_PATH', {
      hint: 'Run it inside a git checkout, or pass file and after to check one proposed change.',
    });
  }
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  } catch {
    throw new PlaywrightMcpError(`Unknown git ref: ${base}`, 'INVALID_INPUT', { hint: 'Fetch it first (git fetch origin main) or use HEAD.' });
  }
  const changed = (await git(root, ['diff', '--name-only', '--no-renames', base, '--', '.']))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const wanted = only?.map((f) => relativeToRoot(top, sanitizeUserPath(f, root)));
  const files = changed.filter((f) => (wanted ? wanted.includes(f) : isGuardedFile(f))).slice(0, MAX_FILES);
  const results: GuardFileResult[] = [];
  for (const file of files) {
    let before: string;
    try {
      before = await git(top, ['show', `${base}:${file}`]);
    } catch {
      continue; // a new file: nothing to weaken
    }
    if (before.length > MAX_FILE_BYTES) continue;
    const after = await readIfExists(joinProjectPath(top, file));
    results.push(guardFileChange(file, before, after));
  }
  return results;
}

export const checkTestChangeTool = {
  name: 'check-test-change',
  description:
    "Heal guard: check that changed tests were not made to pass by checking less. Compares spec files with a git ref (default HEAD = uncommitted changes) or one proposed file (file + after). BLOCK on deleted assertions, skipped/removed tests or .only; WARN on weaker matchers, waitForTimeout, force: true, swallowed errors, raised timeouts or retries. Run it after any AI fix, before committing.",
  inputSchema: checkTestChangeSchema,
  handler: async (args: CheckTestChangeInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('check-test-change', async () => {
      if (ctx.restricted) {
        throw new PlaywrightMcpError('check-test-change is not available on this server', 'INVALID_PATH', {
          hint: 'It reads the project checkout. Run the server locally.',
        });
      }
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      let results: GuardFileResult[];
      let scope: string;
      if (args.after !== undefined || args.file) {
        if (!args.file || args.after === undefined) {
          throw new PlaywrightMcpError('Pass file and after together', 'INVALID_INPUT', {
            hint: 'Or leave both out to check the changes in the working tree against base.',
          });
        }
        const absolute = sanitizeUserPath(args.file, root);
        const before = await readIfExists(absolute);
        if (before === undefined) throw new PlaywrightMcpError(`File not found: ${args.file}`, 'INVALID_PATH');
        results = [guardFileChange(relativeToRoot(root, absolute), before, args.after)];
        scope = 'the file on disk → the proposed version';
      } else {
        const base = assertGitRef(args.base ?? 'HEAD');
        results = await guardAgainstRef(root, base, args.files);
        scope = base === 'HEAD' ? 'last commit → working tree' : `\`${base}\` → working tree`;
      }
      const verdict = guardVerdict(results);
      const findings = results.flatMap((r) =>
        r.findings.map((f) => ({
          file: r.file,
          line: f.line ?? 1,
          rule: f.rule,
          severity: f.severity === 'block' ? ('high' as const) : ('medium' as const),
          message: f.message,
          ...(f.test ? { test: f.test } : {}),
        })),
      );
      const text =
        results.length === 0
          ? '## ✅ OK — no changed spec files\n\nNothing to compare: no spec file or playwright config differs from the base.'
          : renderGuardReport(results, scope);
      return toolText(text, { ok: verdict !== 'BLOCK', status: verdict, findings, total: findings.length });
    }),
};
