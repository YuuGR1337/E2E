/**
 * `playwright-e2e-mcp guard`: the heal guard as a CI step. Compares the
 * changed spec files with a base ref and fails the job when a change made
 * tests pass by checking less (deleted assertions, skipped or removed
 * tests, `.only`). Warnings are printed but do not fail unless --strict.
 *
 * Exit codes: 0 OK (or only warnings), 1 BLOCK (or WARN with --strict),
 * 2 bad arguments or not a git checkout.
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { assertGitRef, guardAgainstRef } from '../tools/check-test-change.js';
import { guardVerdict, renderGuardReport } from '../utils/test-change-guard.js';

export const GUARD_USAGE = [
  'Usage: playwright-e2e-mcp guard [options]',
  '',
  'Checks that changed tests were not made to pass by checking less: blocks deleted',
  'assertions, skipped or removed tests and .only; warns on weaker matchers, hard',
  'waits, force: true, swallowed errors and raised timeouts or retries.',
  '',
  '  --base <ref>           git ref to compare with (default: HEAD; in a PR use origin/main)',
  '  --project-root <dir>   project directory (default: cwd)',
  '  --strict               warnings fail the check too',
  '  --json                 print the result as JSON',
  '',
  'Exit codes: 0 OK, 1 blocked, 2 bad arguments.',
  '',
].join('\n');

export async function runGuard(argv: string[]): Promise<number> {
  let values: { base?: string; 'project-root'?: string; strict?: boolean; json?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        base: { type: 'string' },
        'project-root': { type: 'string' },
        strict: { type: 'boolean' },
        json: { type: 'boolean' },
      },
      strict: true,
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${GUARD_USAGE}`);
    return 2;
  }
  const root = path.resolve(values['project-root'] ?? process.cwd());
  try {
    const base = assertGitRef(values.base ?? 'HEAD');
    const results = await guardAgainstRef(root.replace(/\\/g, '/'), base);
    const verdict = guardVerdict(results);
    const failed = verdict === 'BLOCK' || (values.strict === true && verdict === 'WARN');
    if (values.json) {
      process.stdout.write(`${JSON.stringify({ verdict, ok: !failed, files: results }, null, 2)}\n`);
    } else {
      const report =
        results.length === 0
          ? '## ✅ OK — no changed spec files\n\nNothing to compare: no spec file or playwright config differs from the base.\n'
          : `${renderGuardReport(results, base === 'HEAD' ? 'last commit → working tree' : `\`${base}\` → working tree`)}\n`;
      process.stdout.write(report);
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) {
        try {
          appendFileSync(summary, `${report}\n`);
        } catch {
          // The job summary is a nicety; the exit code is what matters.
        }
      }
    }
    return failed ? 1 : 0;
  } catch (error) {
    const err = error as Error & { hint?: string };
    process.stderr.write(`guard: ${err.message}${err.hint ? `\n${err.hint}` : ''}\n`);
    return 2;
  }
}
