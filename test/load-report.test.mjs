import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePath } from '../dist/utils/path-utils.js';
import { foreignRebase, parseReportJson, reportGitInfo } from '../dist/utils/report-parser.js';
import { loadReportTool } from '../dist/tools/load-report.js';
import { createToolStore } from '../dist/tools/shared.js';
import { logger } from '../dist/utils/logger.js';

const CI = '/home/runner/work/app/app';

function ciReport() {
  return {
    config: {
      rootDir: `${CI}/tests`,
      configFile: `${CI}/playwright.config.ts`,
      projects: [{ name: 'chromium' }],
      metadata: {
        gitCommit: { hash: 'abc1234def5678', shortHash: 'abc1234', subject: 'Make cart async', branch: 'main' },
        ci: { buildHref: 'https://github.com/o/r/actions/runs/1', commitHash: 'abc1234def5678' },
      },
    },
    stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0, duration: 4_000 },
    suites: [
      {
        title: 'cart.spec.ts',
        file: 'cart.spec.ts',
        specs: [
          {
            title: 'adds an item',
            file: 'cart.spec.ts',
            line: 3,
            tests: [
              {
                projectName: 'chromium',
                results: [
                  {
                    status: 'failed',
                    retry: 0,
                    duration: 1_200,
                    error: { message: 'expect(locator).toHaveText(expected)', stack: `Error\n    at ${CI}/tests/cart.spec.ts:5:7` },
                    attachments: [{ name: 'trace', contentType: 'application/zip', path: `${CI}/test-results/cart-adds-an-item-chromium/trace.zip` }],
                  },
                ],
              },
            ],
          },
          {
            title: 'shows total',
            file: 'cart.spec.ts',
            line: 9,
            tests: [{ projectName: 'chromium', results: [{ status: 'passed', retry: 0, duration: 800 }] }],
          },
        ],
      },
    ],
  };
}

test('reportGitInfo reads commit, branch, subject and build link', () => {
  assert.deepEqual(reportGitInfo(ciReport()), {
    commit: 'abc1234def5678',
    branch: 'main',
    subject: 'Make cart async',
    buildUrl: 'https://github.com/o/r/actions/runs/1',
  });
  assert.equal(reportGitInfo({ config: {} }), undefined);
});

test('foreignRebase maps the CI checkout onto the local root only for foreign reports', () => {
  const rebase = foreignRebase(`${CI}/playwright.config.ts`, '/local/app', { traceDirs: [] });
  assert.equal(rebase(`${CI}/tests/a.spec.ts`), '/local/app/tests/a.spec.ts');
  assert.equal(rebase('/elsewhere/x'), '/elsewhere/x');
  assert.equal(foreignRebase(`${CI}/playwright.config.ts`, '/local/app', undefined)(`${CI}/x`), `${CI}/x`);
  assert.equal(foreignRebase('/local/app/playwright.config.ts', '/local/app', { traceDirs: [] })('/local/app/x'), '/local/app/x');
});

test('parseReportJson finds a CI trace in the unpacked artifact folder', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pw-foreign-')));
  const artifact = path.join(root, 'ci-artifacts', 'cart-adds-an-item-chromium');
  mkdirSync(artifact, { recursive: true });
  writeFileSync(path.join(artifact, 'trace.zip'), 'zip');
  const parsed = parseReportJson(JSON.stringify(ciReport()), root, undefined, { traceDirs: [path.join(root, 'ci-artifacts')] });
  assert.equal(parsed.failures.length, 1);
  assert.equal(parsed.failures[0].file, 'tests/cart.spec.ts');
  assert.equal(parsed.failures[0].tracePath, normalizePath(path.join(root, 'ci-artifacts', 'cart-adds-an-item-chromium', 'trace.zip')));
  assert.equal(parsed.git?.commit, 'abc1234def5678');
  // Without the foreign option, CI paths outside the root are never followed.
  assert.equal(parseReportJson(JSON.stringify(ciReport()), root).failures[0].tracePath, undefined);
});

test('load-report imports a CI run as the last run and records its commit', async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pw-load-')));
  mkdirSync(path.join(root, 'ci', 'test-results', 'cart-adds-an-item-chromium'), { recursive: true });
  writeFileSync(path.join(root, 'ci', 'results.json'), JSON.stringify(ciReport()));
  writeFileSync(path.join(root, 'ci', 'test-results', 'cart-adds-an-item-chromium', 'trace.zip'), 'zip');
  const store = createToolStore();
  const ctx = { logger: logger.child({ tool: 'test' }), store, projectRoot: root };
  const result = await loadReportTool.handler({ report: 'ci/results.json' }, ctx);
  const text = result.content[0].text;
  assert.ok(!result.isError, text);
  assert.match(text, /## Imported run —/);
  assert.match(text, /commit `abc1234d` on `main`/);
  assert.match(text, /\*\*Traces:\*\* found for all 1 failure/);
  assert.match(text, /\*\*History:\*\* recorded/);
  assert.equal(store.lastRun?.result.imported?.git?.commit, 'abc1234def5678');
  const history = readFileSync(path.join(root, '.playwright-e2e-mcp', 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(history.length, 1);
  assert.equal(history[0].source, 'load-report');
  assert.equal(history[0].commit, 'abc1234def5678');
  assert.equal(history[0].subject, 'Make cart async');
});

test('load-report refuses paths outside the project and restricted servers', async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pw-load-')));
  const ctx = { logger: logger.child({ tool: 'test' }), store: createToolStore(), projectRoot: root };
  const outside = await loadReportTool.handler({ report: '../x.json' }, ctx);
  assert.equal(outside.isError, true);
  const missing = await loadReportTool.handler({ report: 'nope.json' }, ctx);
  assert.match(missing.content[0].text, /gh run download/);
  const restricted = await loadReportTool.handler({ report: 'x.json' }, { ...ctx, restricted: true });
  assert.match(restricted.content[0].text, /not available on this server/);
});
