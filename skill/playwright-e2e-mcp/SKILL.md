---
name: playwright-e2e-mcp
description: Runs, debugs and fixes Playwright end-to-end tests through the playwright-e2e-mcp server, using structured run results grouped by root cause, trace-based failure diagnostics, verified locators, self-healing fixes that re-run and revert if still red, per-test flaky verdicts that separate parallelism, test-order and timing bugs, signed-in page inspection with network mocks, WCAG accessibility audits, Web Vitals performance audits and local run history, plus a guide to writing tests that stay green. Use when the user asks to run Playwright tests, fix a failing or broken e2e test, find out why a test is flaky or which tests are unstable, repair a selector that no longer matches, write or review a Playwright test, check a page for accessibility, performance or visual regressions.
---

# Playwright E2E with playwright-e2e-mcp

This skill drives the `playwright-e2e-mcp` MCP server. The server runs Playwright
for you and returns structured results instead of raw terminal output: pass/fail
stats, each failure with `file:line`, a failure kind, the DOM at the moment of
failure (read from the Playwright trace), failed network requests, console errors
and concrete next steps. It can also propose and apply a verified fix for a broken
locator, inspect pages behind a login, run long suites in the background and keep
a local history of every run.

This skill is written for playwright-e2e-mcp 0.4.2 and works with 0.2.0 or
newer. If `suggest-fix`, `get-run-status` or `analyze-history` is missing, the
server is older than 0.2.0: use the steps that do not need those tools and tell
the user to update it. `diagnose-flaky`'s per-test table and `isolate` option
arrived in 0.3.0; `audit-accessibility`, `diagnose-flaky`'s `order` option and
root-cause grouping in `run-test` arrived in 0.4.0; `audit-performance`, network
mocks (`routes`) and strict-mode fixes in `suggest-fix` arrive in 0.5.0.

## Before you start

1. Check that the server's tools are available. They are named `run-test`,
   `get-run-status`, `get-failure`, `suggest-fix`, `inspect-page`,
   `validate-selector`, `list-tests`, `generate-e2e-test`,
   `compare-visual-state`, `audit-accessibility`, `audit-performance`,
   `diagnose-flaky` and
   `analyze-history` (your client
   may prefix them, e.g. `mcp__playwright-e2e__run-test`).
2. If they are all missing, stop and tell the user the MCP server is not
   connected. Point them to `references/setup.md` for the one-line install for
   their client (`npx -y playwright-e2e-mcp init` sets up every client the
   project uses). Writing or reviewing tests by hand still works: follow
   `references/writing-tests.md`. Do not fall back to shelling out to `npx playwright test` unless
   the user asks. If only some are missing, the server may run a smaller tool
   profile (`--tools=core` exposes `run-test`, `get-run-status`, `get-failure`,
   `suggest-fix`, `diagnose-flaky` and `list-tests`); work with what is there and
   mention the profile when a task needs a page tool.
3. Every tool except `get-run-status` takes an optional `projectRoot`. Leave it
   out unless the user works in a sub-project; the server defaults to `PW_MCP_PROJECT_ROOT` or its working
   directory, and rejects any root outside its allowed roots.
4. If the client offers the server's prompts as slash commands,
   `/fix-failing-test` and `/triage-flaky-tests` start the two main workflows
   below.

## The core loop: fix a failing test

Follow these steps in order. Do not edit code before step 3.

1. **Run.** Call `run-test` with the narrowest scope you know:
   `{ "testFiles": ["tests/checkout.spec.ts"] }`, or `file:line`, or `grep`.
   Omit `testFiles` only when the user asks for the whole suite. Failing tests are
   retried once by default, so a test that passes on retry is reported as
   **flaky**, not failed. For a long suite pass `background: true` and poll
   `get-run-status` with `waitSeconds: 30`. When several tests fail the same
   way, the result says how many distinct causes there are and shows each
   cause once: fix the cause, not each test (a dead server or one changed
   shared component often fails dozens of tests).
2. **Read the failure.** For each failure, call `get-failure` with its 1-based
   `index`. Read the message and code frame, expected vs actual, the failure kind,
   the DOM snapshot at failure, the failed action and its selector, failed network
   requests and console errors.
3. **Decide what is wrong** using the failure kind (see
   `references/failure-kinds.md`):
   - `server-unreachable` / `SERVER_NOT_RUNNING`: the app is not running. Tell the
     user to start the dev server, or suggest `webServer` in the Playwright config.
     Do not edit tests.
   - "strict mode violation … resolved to N elements": the locator matches more
     than one element. Call `suggest-fix`; it picks the exact-name match itself,
     or lists the matches so you can pass `candidate: <n>` for the one the test
     meant (read the test's intent; ask the user if it is unclear). If the
     duplicates should not exist (a dialog rendered twice), it is an app bug.
   - A locator or selector in the message, or "0 elements": call `suggest-fix`
     with the same `index`. If it returns a diff with `high` confidence, call it
     again with `apply: true`; it re-runs the test and reverts if still red. If it
     says the element is missing, treat it as an app bug and report the evidence.
     Otherwise go to the selector loop below.
   - `assertion` with a sensible selector: compare expected vs actual and the DOM
     snapshot. Decide whether the app regressed or the test expectation is stale,
     and say which before changing anything.
   - `timeout`: check the DOM snapshot and failed requests for a slow or failed
     API call before raising any timeout.
   - Failed network request (4xx/5xx/no response) right before the failure: the
     backend is the likely cause; report it.
4. **Fix** the spec or the app code, the smallest change that addresses the cause.
5. **Re-run only what failed:** `run-test` with `{ "lastFailed": true }`. Repeat
   from step 2 until green.

## Selector loop: a locator no longer matches

1. `inspect-page` with the page URL and `view: "locators"`
   (e.g. `{ "url": "http://localhost:3000/checkout", "view": "locators" }`).
   Behind a login, pass `storageState` (the project's saved auth file); to reach a
   modal or later step, pass `actions`. Every locator listed was checked to match
   exactly one element.
2. Pick a replacement. Prefer, in order: role + accessible name (`getByRole`),
   `getByTestId`, label/placeholder, then a short stable CSS selector. Avoid
   positional selectors such as `:nth-child` and generated class names.
3. `validate-selector` with `{ "url": ..., "selector": ... }` before editing the
   spec. It accepts locator expressions as written in the spec. Only use one that
   comes back `✅ VALID` with exactly 1 match.
4. Update the spec and re-run with `lastFailed: true`.

## Pages behind a login

`inspect-page`, `validate-selector` and `compare-visual-state` open the page in a
fresh browser, so a signed-in page shows the login screen unless you pass state:

- `storageState`: path inside the project to a Playwright storageState JSON, such
  as `playwright/.auth/user.json` written by the project's setup project. Look for
  it in `playwright.config.*` before asking the user. The server can default to
  `PW_MCP_STORAGE_STATE`.
- `headers`: extra HTTP headers, e.g. an API token the user gave you. Never invent
  or log credentials.
- `actions`: up to 20 steps after load (`click`, `fill`, `press`, `check`,
  `select`, `hover`, `wait`, `goto`, ...) to open a modal or reach a later step.
- `routes`: up to 20 network mocks applied before load, first match wins:
  `{ "url": "**/api/cart", "json": { "items": [] } }` for an empty state,
  `"status": 500` for an error state, `"abort": true` to drop a third party,
  `"delayMs"` alone to slow the real request. The response flags a mock that
  matched nothing; fix the glob before trusting the result.
- `viewport`: `{ "width": 390, "height": 844 }` for mobile layouts.

When a response says the page landed on a login screen, retry with
`storageState`. `suggest-fix` takes `storageState` and `headers` too when you heal
against a live `url`.

## Flaky or intermittent failures

Start with `analyze-history` (default view `flaky`) to see which tests flip
between pass and fail across recorded runs, which regressed, and which are simply
broken; `view: "patterns"` groups failures that share a cause. Then call
`diagnose-flaky` on the worst ones (optionally `{ "testFiles": [...], "runs": 5 }`;
with no `testFiles` it takes the tests that failed in the last run). It repeats
them with retries disabled, in one Playwright process, and returns a table with
one verdict **per test** (passes, failures, duration spread, first error):

- **CONSISTENTLY FAILING**: not flaky; treat it as a real failure (core loop).
- **FLAKY**: some runs passed. Same error signature each time points to a real
  race in the app or test; varying errors point to timing or environment. Look for
  missing awaits, assertions without auto-waiting, shared state between tests and
  fixed `waitForTimeout` sleeps. Never "fix" flakiness by only adding retries or
  sleeps.
- **NOT REPRODUCING**: passed every run. Report that the failure was one-off.

When a test is FLAKY and the suite runs in parallel, call `diagnose-flaky` again
with `isolate: true`. It repeats the tests fully parallel, then repeats the
failing ones with one worker, and reads each one:

- **fails only in parallel**: the test shares state with others (same user or
  account, DB rows, files, ports, a global fixture). Fix the data isolation, for
  example per-worker data from `testInfo.workerIndex`; do not just serialize the
  whole suite.
- **flaky even alone**: the race is inside the test or the app.
- **fails alone too**: a real bug, not parallelism.

When a test fails in the full suite but `diagnose-flaky` on that test alone says
**NOT REPRODUCING**, suspect test order: call it again with `order: true` and
the spec file(s) in `testFiles` (Playwright 1.64+). It runs the files in random
orders with one worker, replays a failing order, and reads each test:

- **order dependent**: fails after certain tests and fails again on replay. The
  result names the test it **relies on** (state it needs another test to create)
  or is **broken by** (state another test leaves behind), and the
  `--shuffle=<seed>` command that reproduces it. Fix it by giving the test its
  own setup (`beforeEach`, a fixture, its own data) and cleaning up in the test
  that leaks; do not pin the file to serial mode.
- **flaky regardless of order**: the failing order passed on replay: timing.
- **fails in every order**: a real bug.

Pass `separateProcesses: true` only when the flake seems tied to global setup or
a cold start, since one process per run is slower. `get-failure` works on the
last failing diagnose run straight after, and each repetition is recorded in the
history, so `diagnose-flaky` with `runs: 5` is also the quickest way to seed
history for `analyze-history`.

Every `run-test`, `diagnose-flaky` and `suggest-fix` run is recorded in
`<project>/.playwright-e2e-mcp/history.jsonl` on the user's machine;
`analyze-history` with `view: "test"` and a `test` filter shows one test's
pass/fail timeline.

## Other tasks

- **List tests:** `list-tests`, with `filter` for a substring of `file › title`.
- **Write a new test:** `generate-e2e-test` with a `description` (and `pageUrl` if
  there is no `baseURL`). It scaffolds a spec from selectors the project actually
  declares, from recent git changes, and reports each selector's source. Review the
  file it writes, then `run-test` it. Pass `write: false` to preview without
  writing.
- **Set up CI:** when the user wants the same diagnosis on every pull request,
  point them to the GitHub Action (`uses: xsignon-secure/E2E@v0.4.2`) or the
  `npx -y playwright-e2e-mcp ci` command in `references/setup.md`. It writes the
  run, flaky verdicts and fix diffs to the job summary and one PR comment.
- **Accessibility:** `audit-accessibility` with `url` runs axe-core against
  WCAG 2.2 A/AA (`standard` picks another level or `best-practice`). It takes
  the same `storageState`, `headers` and `actions` as `inspect-page`, so audit
  the signed-in pages and open dialogs, not only the landing page. Each
  violation lists the offending elements as verified locators and the fix; fix
  the worst (`critical`, `serious`) first, re-run the audit, then add the
  `AxeBuilder` check it prints to the spec that reaches that page so it stays
  fixed. Pass `minImpact: "serious"` for a short list.
- **Performance:** `audit-performance` with `url` measures LCP, CLS, TBT, FCP,
  TTFB, and INP for the clicks and key presses in `actions`. Use
  `throttle: "mobile"` for a phone on slow 4G and `runs: 3` before comparing
  numbers, since one lab load is noisy. Pass `budgets` (e.g. `{ "lcpMs": 2500,
  "cls": 0.1 }`) when the user has targets. Fix what it names (the LCP element,
  the elements that shifted, long tasks, render-blocking and heavy requests),
  re-measure with the same settings, then add the budget test it prints. Say
  that these are lab numbers; field data can differ.
- **Write or review a test:** follow `references/writing-tests.md` (locators,
  web-first assertions, auth setup, test data, network mocking, flake
  patterns), with or without the server.
- **Visual regression:** `compare-visual-state` with `url` and a `name`. The first
  call saves a baseline under `.pw-mcp/visual/`; later calls report changed
  regions and color shifts and write a diff image. Use `action: "baseline"` only
  when the user confirms the new look is intended.

## Reporting back

When you finish, tell the user, in this order:

1. The result: which tests now pass, fail or are flaky (counts from the last
   `run-test`).
2. The cause of each failure you fixed, with the `file:line` you changed.
3. Anything you did not fix and why (app bug, server down, needs a decision).

## Things to avoid

- Do not raise timeouts, add retries, add `waitForTimeout`, or delete or
  `test.skip` a test to make a run green, unless the user explicitly asks.
- Do not accept a new visual baseline without the user's confirmation.
- Do not pass `allowExpectationUpdate: true` to `suggest-fix` unless the user
  confirms the new text is intended; a changed expected value can be a real bug.
- Do not point `inspect-page` or `validate-selector` at sites the user did not
  name; they open real pages in a headless browser.
- `run-test` executes the project's own test code. Run it only in projects the
  user has asked you to work on.

## References

- `references/setup.md`: install and client configuration, environment variables.
- `references/tools.md`: every tool's arguments.
- `references/failure-kinds.md`: failure kinds and error codes, and what to do.
- `references/example-session.md`: a worked fix-a-failing-test session with
  `suggest-fix`.
- `references/writing-tests.md`: how to write Playwright tests that stay green,
  and the review checklist.
