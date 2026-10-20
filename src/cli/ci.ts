/**
 * `playwright-e2e-mcp ci`: the same diagnosis the MCP tools give an agent,
 * as a plain command for CI. It runs the suite (auto-retry once, so flaky
 * tests are reported as flaky rather than failed), optionally repeats the
 * failures through diagnose-flaky and drafts suggest-fix diffs, and writes
 * one Markdown report: to stdout, to --output, and to the GitHub job
 * summary when GITHUB_STEP_SUMMARY is set.
 *
 * Exit codes: 0 all passed (flaky allowed), 1 tests failed, 2 the run
 * itself failed (no Playwright, config error, timeout) or bad arguments.
 */

import { appendFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { ToolContext, ToolResponse } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { createToolStore } from '../tools/shared.js';
import { runTestTool } from '../tools/run-test.js';
import { diagnoseFlakyTool } from '../tools/diagnose-flaky.js';
import { suggestFixTool } from '../tools/suggest-fix.js';

export const CI_USAGE = [
  'Usage: playwright-e2e-mcp ci [options] [test files…]',
  '',
  'Runs the Playwright suite and writes a Markdown diagnosis (stdout, --output,',
  'and $GITHUB_STEP_SUMMARY when set). Exit 0 = passed, 1 = tests failed, 2 = run error.',
  '',
  '  --project-root <dir>   project directory (default: PW_MCP_PROJECT_ROOT or cwd)',
  '  --config <path|n>      playwright.config path or 1-based index',
  '  --browser <name>       chromium | firefox | webkit',
  '  --grep <regex>         only tests whose title matches',
  '  --workers <n>          Playwright workers',
  '  --timeout <ms>         wall-clock limit for the run (default 600000)',
  '  --no-retry             do not auto-retry failures once',
  '  --flaky-runs <n>       repeat failing tests n times (2-10) for a flaky verdict',
  '  --suggest <n>          draft suggest-fix diffs for the first n failures (max 5)',
  '  --output <file>        also write the report to this file (for a PR comment)',
  '',
].join('\n');

export interface CiOptions {
  projectRoot?: string;
  config?: string;
  browser?: 'chromium' | 'firefox' | 'webkit';
  grep?: string;
  workers?: number;
  timeoutMs: number;
  retry: boolean;
  flakyRuns?: number;
  suggest: number;
  output?: string;
  testFiles: string[];
}

function intOption(value: string | undefined, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be an integer from ${min} to ${max}`);
  return n;
}

/** Parse `ci` arguments (everything after the subcommand). Throws on bad input. */
export function parseCiArgs(argv: string[]): CiOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      'project-root': { type: 'string' },
      config: { type: 'string' },
      browser: { type: 'string' },
      grep: { type: 'string' },
      workers: { type: 'string' },
      timeout: { type: 'string' },
      'no-retry': { type: 'boolean' },
      'flaky-runs': { type: 'string' },
      suggest: { type: 'string' },
      output: { type: 'string' },
    },
  });
  const browser = values.browser;
  if (browser !== undefined && browser !== 'chromium' && browser !== 'firefox' && browser !== 'webkit') {
    throw new Error('--browser must be chromium, firefox or webkit');
  }
  return {
    projectRoot: values['project-root'],
    config: values.config,
    browser,
    grep: values.grep,
    workers: intOption(values.workers, 'workers', 1, 64),
    timeoutMs: intOption(values.timeout, 'timeout', 1_000, 3_600_000) ?? 600_000,
    retry: values['no-retry'] !== true,
    flakyRuns: intOption(values['flaky-runs'], 'flaky-runs', 2, 10),
    suggest: intOption(values.suggest, 'suggest', 0, 5) ?? 0,
    output: values.output,
    testFiles: positionals,
  };
}

function text(response: ToolResponse): string {
  return response.content.map((block) => block.text).join('\n');
}

/** Run the CI flow; returns the exit code. */
export async function runCi(argv: string[]): Promise<number> {
  let options: CiOptions;
  try {
    options = parseCiArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${CI_USAGE}`);
    return 2;
  }

  const projectRoot = options.projectRoot ?? process.env.PW_MCP_PROJECT_ROOT ?? process.cwd();
  const ctx: ToolContext = {
    // Info logs would bury the report in CI output; LOG_LEVEL still wins.
    logger: createLogger({
      level: process.env.LOG_LEVEL || process.env.MCP_LOG_LEVEL ? undefined : 'warn',
      bindings: { name: 'playwright-e2e-mcp', mode: 'ci' },
    }),
    store: createToolStore(),
    projectRoot,
  };

  const sections: string[] = [];
  const run = await runTestTool.handler(
    {
      testFiles: options.testFiles.length > 0 ? options.testFiles : undefined,
      grep: options.grep,
      browser: options.browser,
      workers: options.workers,
      timeoutMs: options.timeoutMs,
      retryOnFailure: options.retry,
      config: options.config,
    },
    ctx,
  );
  sections.push(text(run));

  const result = ctx.store.lastRun?.result;
  const failures = result?.failures ?? [];
  let code = result === undefined || run.isError ? 2 : result.ok ? 0 : failures.length > 0 ? 1 : 2;

  if (code === 1 && options.suggest > 0) {
    // Before diagnose-flaky, which replaces the last run suggest-fix indexes into.
    const count = Math.min(options.suggest, ctx.store.lastRun?.result.failures.length ?? 0);
    for (let index = 1; index <= count; index += 1) {
      const fix = await suggestFixTool.handler({ index, config: options.config }, ctx);
      sections.push(text(fix).replace(/^## /m, '### '));
    }
  }

  if (code === 1 && options.flakyRuns) {
    const flaky = await diagnoseFlakyTool.handler({ runs: options.flakyRuns, config: options.config, browser: options.browser }, ctx);
    sections.push(text(flaky).replace(/^## /m, '### '));
  }

  const report = `${sections.join('\n\n---\n\n')}\n\n<sub>Generated by [playwright-e2e-mcp](https://github.com/trajectiq-ai/E2E) \`ci\`.</sub>\n`;
  process.stdout.write(report);
  try {
    if (options.output) await writeFile(options.output, report, 'utf8');
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report, 'utf8');
  } catch (err) {
    process.stderr.write(`could not write the report: ${(err as Error).message}\n`);
    code = Math.max(code, 2);
  }
  return code;
}
