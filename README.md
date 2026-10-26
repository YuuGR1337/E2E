<p align="center">
  <img src="docs/logo.png" alt="playwright-e2e-mcp logo: a heartbeat line that ends in a green check" width="140">
</p>

<h1 align="center">playwright-e2e-mcp</h1>

<p align="center"><b>The test doctor for AI agents.</b><br>
Your Playwright test fails. Your AI finds out why, fixes it, and proves the fix works.</p>

<p align="center">

[![CI](https://github.com/xsignon-secure/E2E/actions/workflows/ci.yml/badge.svg)](https://github.com/xsignon-secure/E2E/actions/workflows/ci.yml) [![release](https://img.shields.io/github/v/release/xsignon-secure/E2E)](https://github.com/xsignon-secure/E2E/releases) [![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.xsignon--secure%2FE2E-2563eb)](https://registry.modelcontextprotocol.io/)

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=playwright-e2e&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInBsYXl3cmlnaHQtZTJlLW1jcCJdfQ==)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_server-0098FF?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522playwright-e2e%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522playwright-e2e-mcp%2522%255D%257D)
[![Add to Claude Desktop](https://img.shields.io/badge/Claude_Desktop-.mcpb_bundle-D97757)](https://github.com/xsignon-secure/E2E/releases/latest)

</p>

## What it is

An [MCP](https://modelcontextprotocol.io) server and agent skill that gives your AI assistant
(Claude, Cursor, VS Code Copilot, Gemini, Codex) a full Playwright toolkit: a **test runner**,
a **failure detective** and a **fixer that checks its own work**.

Other tools let an AI click around a browser. This one lets it **keep your test suite green**.

```
run-test ──────┐
load-report ───┴─▶ get-failure ──▶ suggest-fix (apply + re-run) ──▶ green
 (CI job report)        │                 └─ refuses when the element is really gone (app bug)
                        └─ DOM at failure, failed requests, console errors
every run ──▶ analyze-history (flaky / broken / slow / which commit broke it)
```

### New in 0.5.0

- **Diagnose CI failures:** `load-report` reads a CI job's report (or sharded blob reports)
  and its traces, so the same diagnosis and verified fixes work on failures from CI.
- **Know which commit broke a test:** run history now records commits; `analyze-history`
  adds `commits`, `slow` and `trend` views.
- **Write tests by walking the flow:** `generate-e2e-test` with `steps` runs them on the live
  page, writes the spec with end-state assertions, and runs it once to prove it passes.
- **Performance audits:** `audit-performance` measures Web Vitals on desktop or a throttled
  phone and hands back a budget test.
- **More page control:** aria snapshots with ready `toMatchAriaSnapshot` assertions, network
  mocks, HAR record/replay, and Chromium, Firefox or WebKit.
- **Smarter fixes:** `suggest-fix` resolves strict-mode violations ("resolved to 2 elements").

[Full release notes](https://github.com/xsignon-secure/E2E/releases/tag/v0.5.0)

## What it does

| | You ask your AI… | It does this |
|---|---|---|
| 🏃 | "Run my tests" | Runs the suite and reports every failure with its file, line, cause and a fix hint. One root cause breaking 30 tests shows up as **one** problem. |
| 🔍 | "Why did this fail?" | Reads Playwright's trace: the page at the moment of failure, the broken request, the console error. No guessing. |
| 🛠️ | "Fix it" | Swaps in a locator proven unique on the page, **re-runs the test**, and undoes the edit if it's still red. If the button is really gone, it tells you it's an app bug instead of hiding it. |
| 🎲 | "Is this test flaky?" | Re-runs it many ways (repeated, alone, in random order) and names the exact test and seed that cause the flake. |
| 📈 | "What's been breaking lately?" | Keeps a local run history and separates flaky, newly broken and always-broken tests; shows the slowest tests, stability by day and **the commit where each test went bad**. |
| ☁️ | "Why did CI fail?" | Loads the CI job's report (or merges sharded blob reports), maps its paths onto your checkout and finds the traces in the downloaded artifact, so the same diagnosis and fixes work on CI failures. |
| ✍️ | "Write a test for this flow" | Walks the steps on the live page first, writes a spec that replays them with assertions on where the flow landed (URL and accessibility snapshot), and runs it once to prove it passes. |
| ♿ | "Check this page for accessibility" | Runs axe-core (WCAG 2.2 AA) and returns each problem with a ready-to-paste locator and regression test. |
| ⚡ | "Why is this page slow?" | Measures Web Vitals (LCP, CLS, INP, TBT) on desktop or a throttled phone, names the slow element and the elements that jump, and hands back a budget test. |
| 🧪 | "Show me the error state" | Mocks API responses (500s, empty lists, slow calls) so the AI can inspect, audit or measure states that are hard to reach. |
| 🔐 | "Test the page after login" | Works behind sign-in with saved sessions, headers and click/fill steps, in Chromium, Firefox or WebKit, and can record or replay network traffic from a HAR file. |
| 🤖 | "Do it in CI" | A [GitHub Action and `ci` command](#ci-github-action-and-ci-command) post the diagnosis, flaky verdict and fix diffs on your PR. |

**Why it stands out**

- **Fixes are proven, not guessed.** Every fix is re-run before it's kept.
- **Honest.** It won't paper over a real bug to make a test pass.
- **Lean.** In the [benchmark](bench/RESULTS.md), finding and fixing a broken locator took about
  **5,300 tokens** here versus about **7,400** with Playwright MCP plus a shell.
- **Teaches as it works.** The bundled skill carries a guide to writing tests that stay green
  (locators, waiting, auth, test data, mocking, flake patterns, review checklist).
- **Ready in one line.** `npx -y playwright-e2e-mcp init` sets up Claude Code, Cursor and VS Code.

### Free and open source, for good

- **MIT licensed.** Use it, change it, ship it in commercial work; no fees, no paid tier, no feature held back.
- **No account, no API key, no sign-up.** `npx -y playwright-e2e-mcp init` is the whole setup.
- **No telemetry.** It never phones home; your tests, traces and run history stay on your machine.
- **Free dependencies only:** the MCP SDK (Apache-2.0), zod (MIT), axe-core (MPL-2.0) and the Playwright your project already has (Apache-2.0).
- **Free to host yourself**, too: the HTTP bridge deploys to a free Vercel account (see [Hosted endpoint](#hosted-endpoint-chatgpt--remote-clients)).

<details>
<summary><b>The technical details</b></summary>

- **Structured runs.** Stats plus each failure's `file:line`, kind (assertion, timeout,
  dead dev server, syntax error, crash, full disk…) and a concrete fix hint. Failures that
  share one cause are grouped. Long suites run in the background with live progress.
- **Diagnosis from the trace.** The DOM at the moment of failure, the failed action, the
  4xx/5xx requests and console errors, read from Playwright's own trace.
- **Verified fixes.** `suggest-fix` matches a broken locator against the DOM at failure, swaps
  in a Playwright locator proven unique on the page
  (`getByRole('button', { name: 'Proceed to checkout' })`), re-runs the test and reverts the
  edit if it is still red. When nothing on the page plausibly matches, it says the element is
  missing and does not patch the test.
- **Flakiness with evidence.** `diagnose-flaky` repeats failing tests in one process and
  gives a verdict per test; `isolate: true` re-runs them alone to tell a shared-state bug from
  a race inside the test, and `order: true` runs files in random orders to catch an order
  dependency, naming the test and the seed that reproduces it. `analyze-history` separates
  flaky, regressed and broken tests from the local run record.
- **Accessibility.** `audit-accessibility` runs axe-core against WCAG 2.2 AA on any page,
  signed in or after steps, with offending elements as verified locators.
- **Performance.** `audit-performance` measures lab Web Vitals (LCP, CLS, TBT, FCP, TTFB, and
  INP for the interactions in `actions`), optionally as a throttled phone and as the median of
  several runs, rates them against Google's thresholds or your budgets, and names the LCP
  element and the elements that shifted as verified locators.
- **Ambiguous locators.** When a locator suddenly matches two elements (strict mode
  violation), `suggest-fix` takes the unique locator Playwright reports for the intended
  match: the exact-name one, or the one you pick.
- **Pages behind a login, in any state.** Every page tool accepts a Playwright
  `storageState`, extra headers, click/fill steps to reach a modal or a later step, and
  network mocks to force error, empty and slow states.

</details>

### What it does not do

It doesn't drive an exploratory browsing session step by step, and it doesn't replace
Playwright's own Test Agents inside VS Code. Use Playwright MCP for interactive browsing and
this server for running, diagnosing and fixing the suite. They work side by side.

## Demo

**Hosted endpoint** — what an `initialize` + `tools/list` round-trip against
`https://playwright-e2e-mcp.vercel.app/api/mcp` returns for a client that sends the
bearer token (without one, only `list-tests` and `get-failure` are listed):

![Token-protected endpoint: initialize handshake and the tool list](https://raw.githubusercontent.com/xsignon-secure/E2E/main/docs/demo-endpoint.png)

**A real test run** — `run-test` served over stdio by `npx -y playwright-e2e-mcp`
against the bundled `examples/sample-test.spec.ts` (actual output, unedited):

![run-test result: 4 passed, 0 failed, 5.1s](https://raw.githubusercontent.com/xsignon-secure/E2E/main/docs/demo-run-test.png)

Images are rendered with `node scripts/gen-demo-images.mjs`: the run-test card is real
captured output; the endpoint card is an illustration of the authenticated listing.

> If this saves you a debugging session, a ⭐ on the repo helps other Playwright users find it.

## Install

Works with Claude Desktop, Claude Code, Cursor, Windsurf, Codex, Gemini CLI, Freebuff
and every other MCP client — pick whichever route fits:

**Let your agent do it.** Paste this into Claude Code, Cursor, Codex, Gemini CLI or any
other coding agent:

> Install the playwright-e2e-mcp server and skill by following
> https://raw.githubusercontent.com/xsignon-secure/E2E/main/llms-install.md

or run the installer yourself from the project root. It merges the server into each
client's project config it finds (Claude Code, Cursor, VS Code, Gemini CLI, Codex) and
installs the agent skill, leaving your other servers alone:

```bash
npx -y playwright-e2e-mcp init            # --client all | cursor,vscode … · --dry-run
```

| Route | How |
| --- | --- |
| **One command, any project** | `npx -y playwright-e2e-mcp init` |
| **Claude Code plugin (server + skill)** | `/plugin marketplace add xsignon-secure/E2E` then `/plugin install playwright-e2e-mcp@xsignon-secure` |
| **Gemini CLI extension (server + skill)** | `gemini extensions install https://github.com/xsignon-secure/E2E` |
| **Skill only, any agent** | `npx skills add xsignon-secure/E2E` |
| **npm (canonical, fastest)** | `npx -y playwright-e2e-mcp` |
| **MCP Registry** (registry-aware clients discover it automatically) | `io.github.xsignon-secure/E2E` — [listing](https://registry.modelcontextprotocol.io/) |
| **Any client, no npm account needed** | `npx -y github:xsignon-secure/E2E#v0.5.0` (pin a release tag) |
| **Claude Desktop, zero Node setup** | double-click the [`.mcpb` extension](https://github.com/xsignon-secure/E2E/releases) |
| **Remote-only clients (ChatGPT connectors)** | `https://playwright-e2e-mcp.vercel.app/api/mcp` |

One line for the common clients:

```bash
claude mcp add playwright-e2e -- npx -y playwright-e2e-mcp
code --add-mcp '{"name":"playwright-e2e","command":"npx","args":["-y","playwright-e2e-mcp"]}'
```

Only need the fix loop? `--tools=core` (or `PW_MCP_TOOLS=core`) exposes six tools and
cuts the tool-definition context by about three quarters; see [Configuration](#configuration).

Details and per-client config: [Installation](#installation) ·
[MCP client configuration](#mcp-client-configuration).

---

## Tools

| Tool | Purpose |
| --- | --- |
| `run-test` | Run Playwright tests and return stats, failures, diagnostics and hints; reports progress, and `background: true` returns a run id for long suites |
| `get-run-status` | Progress or final result of a background run; can wait for it or cancel it |
| `get-failure` | Deep analysis of one failure: stack, expected/actual, **DOM snapshot at failure (from the Playwright trace)**, failed requests, console errors, next steps |
| `load-report` | Load a run from CI: a JSON report or a folder of sharded blob reports; CI paths are mapped onto the checkout and traces found in the unpacked artifact, so `get-failure`, `suggest-fix` and `diagnose-flaky` work on it, and the run joins the history with its commit |
| `suggest-fix` | Patch a failure: a drifted locator is replaced with one **proven unique** on the DOM at failure, an ambiguous one (strict mode violation) gets the unique locator of the intended match, changed copy gets the new expected text; `apply: true` writes it, re-runs the test and reverts if still red |
| `inspect-page` | Open a URL headlessly (optionally signed in, after steps) and return elements with **verified Playwright locators**, CSS selectors, visibility, text and console output, or the **accessibility snapshot with a ready `toMatchAriaSnapshot` assertion** |
| `list-tests` | List available tests (`file`, `line`, full title, projects) with filtering |
| `validate-selector` | Check a CSS selector, Playwright selector or **locator expression** against a live page: validity, match count, and a sturdier verified locator for each match |
| `generate-e2e-test` | Scaffold a Playwright test from a description using the project's **real** selectors and verified locators from the live page, or **walk a flow** step by step on the live page and write a spec that is run once to prove it passes |
| `compare-visual-state` | Visual regression: screenshot before/after a change and report *what* moved and how colors shifted |
| `audit-accessibility` | Run axe-core (WCAG 2.2 AA by default) on a page, signed in or after steps, and return violations worst first with **verified locators** for the offending elements and a regression check |
| `audit-performance` | Measure lab **Web Vitals** (LCP, CLS, TBT, FCP, TTFB, INP during steps), optionally as a throttled phone and the median of several runs; rate them or check budgets, name the LCP and shifting elements as verified locators, list heavy and render-blocking requests, and return a budget test |
| `diagnose-flaky` | Run a failing test 2–10 times **with retries disabled** and return an evidence verdict: `CONSISTENTLY FAILING`, `FLAKY` or `NOT REPRODUCING`; tells parallelism and **test-order** bugs from races |
| `analyze-history` | Rank flaky, regressed and broken tests from the local run history, group failures by cause, list the slowest tests, show stability by day, name **the commit where each test went bad**, or show one test's timeline |

Two **prompts** package the main workflows for clients that show them as slash commands:
`fix-failing-test` (optional `test`) and `triage-flaky-tests`.

### Page state: signed-in pages, headers and steps

`inspect-page`, `validate-selector`, `compare-visual-state`, `audit-accessibility` and
`audit-performance` accept the same page-state arguments (`suggest-fix` accepts
`storageState` and `headers` for a live `url`):

| Argument | Type | Description |
| --- | --- | --- |
| `storageState` | string | Path inside the project to a Playwright storageState JSON (cookies + localStorage), e.g. `playwright/.auth/user.json` from your setup project. Defaults to `PW_MCP_STORAGE_STATE` |
| `headers` | object | Extra HTTP headers for every request, e.g. `{ "Authorization": "Bearer …" }` |
| `actions` | array | Up to 20 steps run after load: `{ "type": "click" \| "dblclick" \| "hover" \| "fill" \| "press" \| "check" \| "uncheck" \| "select" \| "wait" \| "goto", "locator"?, "value"?, "url"?, "ms"? }`. Locators use Playwright syntax, e.g. `getByRole('button', { name: 'Open settings' })` |
| `routes` | array | Up to 20 network mocks applied before the page loads, first match wins: `{ "url": "**/api/cart", "method"?, "status"?, "json"? \| "body"?, "contentType"?, "headers"?, "abort"?, "delayMs"? }`. `json`, `body` or `status` fulfils the request, `abort: true` fails it, and `delayMs` alone slows the real request |
| `viewport` | object | `{ "width": 390, "height": 844 }` (default 1280×720) |
| `har` | object | `{ "path": "tests/fixtures/cart.har", "mode"?: "replay" \| "record", "url"?: "**/api/**", "notFound"?: "abort" \| "fallback" }`. `replay` (default) answers matching requests from the file, `record` saves the page's traffic to it. The file and its folder must be inside the project. `routes` mocks still win over the HAR |
| `browser` | `chromium` \| `firefox` \| `webkit` | Browser engine (default `chromium`; the engine must be installed with `npx playwright install`). `audit-performance` is Chromium-only, and WebKit is refused while private addresses are blocked |

Mocks make states that are hard to reach easy to inspect, audit or measure: the error
banner after a 500, the empty list, the spinner of a slow API, the page without a
third-party script. The response says how many requests each mock handled and flags a mock
that matched nothing, which usually means a wrong glob:

```json
"routes": [
  { "url": "**/api/cart", "json": { "items": [] } },
  { "url": "**/api/checkout", "method": "POST", "status": 500, "body": "boom" },
  { "url": "**/googletagmanager.com/**", "abort": true }
]
```

A HAR makes a page repeatable: record it once against a working backend
(`"mode": "record"`), then replay it so the page renders the same data offline or in CI.
The same file works in a spec with `page.routeFromHAR()`.

A failing step reports which one failed and how many ran. When the page lands on a login
screen, the response says so and suggests `storageState`.

### `run-test`

| Argument | Type | Description |
| --- | --- | --- |
| `projectRoot` | string | Project directory inside the configured root (default: server working directory) |
| `testFiles` | string[] | Files/directories relative to the root; `file:line` supported. Omit to run everything |
| `grep` | string | Only run tests whose title matches this regex |
| `browser` | `chromium` \| `firefox` \| `webkit` | Playwright project to run (matched against config project names) |
| `headed` | boolean | Visible browser window |
| `timeoutMs` | number | Hard wall-clock limit for the run (default `120000`); the whole process tree is killed past it and **partial results are returned** |
| `testTimeoutMs` | number | Per-test timeout passed to Playwright |
| `workers` / `retries` | number | Passed through to Playwright |
| `config` | string | `playwright.config` path **or 1-based index** when the project has several |
| `retryOnFailure` | boolean | Auto-retry failures **once** before reporting them (default `true`; ignored when `retries` is set) |
| `lastFailed` | boolean | Only re-run tests that failed in the previous run (Playwright `--last-failed`) — the fast fix → re-run loop |
| `args` | string[] | Extra Playwright flags from an allowlist (`--repeat-each=N`, `--max-failures=N`, `--update-snapshots`, `--shard=1/3`, `--trace=on`, …); values go after `=` and are checked, and flags that take a path, such as `--config` or `--output`, are rejected |
| `background` | boolean | Return a run id at once; poll `get-run-status` for progress and the result |

Progress: clients that send a progress token get a notification as each test finishes
(`3/12 tests done, 1 failed`). Every run is appended to the local history used by
`analyze-history`.

Flakiness handling: by default the server injects `--retries=1` (unless the config
already sets `retries`), so a test that passes on the retry is reported as **flaky**,
not failed. Traces are captured automatically (`--trace=retain-on-failure`) so
`get-failure` can show the DOM at the moment of failure.

Example result:

```markdown
## Playwright run — ❌ FAILED

**Command:** `playwright test --config playwright.config.ts tests/checkout.spec.ts --reporter=json`
**duration 4.2s · exit 1 · config `playwright.config.ts`**

| passed | failed | flaky | skipped | duration |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 1 | 0 | 0 | 1.1s |

### ❌ 1 failing test(s)

### 1 of 1. checkout.spec.ts › pays with card
**File:** `checkout.spec.ts:5`  |  **failed · server-unreachable**

### ⚠️ SERVER_NOT_RUNNING
Your app (dev server) does not appear to be reachable. Start it in another terminal
(e.g. npm run dev / npm start), keep it running, then retry — or configure `webServer`
in playwright.config.* so Playwright starts it automatically.
```

### `get-failure`

| Argument | Type | Description |
| --- | --- | --- |
| `index` | number | 1-based failure index from the last run (default `1`) |
| `projectRoot` | string | Only used when re-reading the stored report |

Returns the message/code frame, expected vs actual, stack, failure kind with a
diagnosis, the test's console output, **the DOM snapshot from the Playwright trace
(plus the failed action, its selector, and the action log leading up to it)**,
**the network requests that failed** (4xx/5xx, dead endpoints, no-response — with
method, URL, status and resource type), **the console errors/warnings the page
logged before the failure**, and
numbered next steps (re-run this single test by `file:line`, headed/debug mode,
`validate-selector` when the message mentions a locator, …).

### `inspect-page`

| Argument | Type | Description |
| --- | --- | --- |
| `url` | string | Full http(s) URL to open (required) |
| `view` | `elements` \| `locators` \| `aria` | `locators` returns a compact map of interactive elements with verified locators (cheapest); `aria` the accessibility snapshot of the page (or of `selector`) with a ready `toMatchAriaSnapshot` assertion; `elements` (default) the DOM inventory |
| `projectRoot` | string | Project whose Playwright launches the browser |
| `selector` | string | Inspect matches of this selector instead of the whole DOM |
| `waitFor` | string | Wait for a selector (CSS or `text=…`) before inspecting |
| `waitUntil` | `load` \| `domcontentloaded` \| `networkidle` | Navigation wait condition |
| `includeHtml` | boolean | Include the rendered HTML (capped) |
| `maxHtmlChars` | number | HTML cap, default `20000` |
| `timeoutMs` | number | Overall limit, default `45000` |
| `storageState` / `headers` / `actions` / `routes` / `har` / `browser` / `viewport` | — | [Page state](#page-state-signed-in-pages-headers-and-steps) |

Each element comes with Playwright locators that were **checked on the page** to resolve to
exactly that element, best first (role + accessible name, test id, label, placeholder, text,
then CSS), plus its unique CSS selector, visibility, box and text. Console messages are
captured, errors first. A locator map looks like:

```markdown
1. `getByRole('button', { name: 'Proceed to checkout' })` — button "Proceed to checkout" · also `getByTestId('checkout-btn')`
2. `getByLabel('Search')` — searchbox "Search"
```

`view: "aria"` returns the page's structure as Playwright sees it, and the assertion that
locks it in a test:

```ts
await expect(page.locator("#cart")).toMatchAriaSnapshot(`
  - list:
    - listitem: Real item
`);
```

### `list-tests`

| Argument | Type | Description |
| --- | --- | --- |
| `projectRoot` | string | Project directory |
| `config` | string | Config path or 1-based index |
| `testDir` | string | Restrict scanning to a directory (must stay inside the project) |
| `filter` | string | Case-insensitive substring filter on `file › title` |
| `limit` | number | Max tests returned, default `500` |

Uses `playwright test --list` when Playwright works, and **falls back to a source scan**
(keeping the reason) when the install or a spec file is broken.

### `validate-selector`

| Argument | Type | Description |
| --- | --- | --- |
| `url` | string | Live page to test against (required) |
| `selector` | string | CSS, a Playwright selector (`text=`, `role=`, `>>`) or a locator expression such as `getByRole('button', { name: 'Save' }).first()` (required) |
| `projectRoot` | string | Project whose Playwright launches the browser |
| `timeoutMs` | number | Overall limit, default `45000` |
| `storageState` / `headers` / `actions` / `viewport` | — | [Page state](#page-state-signed-in-pages-headers-and-steps) |

Locator expressions are parsed into a whitelisted call chain (`getByRole`, `getByText`,
`getByLabel`, `getByPlaceholder`, `getByAltText`, `getByTitle`, `getByTestId`, `locator`,
`first`, `last`, `nth`, `filter`) and are never evaluated as code.

Verdicts: `✅ VALID — N matches` with a sample of matches and a **unique locator** for each,
a strict-mode warning when more than one element matches, a hint when a CSS selector is
brittle (`:nth-child`, long descendant chains, XPath), `✅ VALID — 0 matches` with debugging
advice, or `❌ INVALID` with the parse error.

### `generate-e2e-test`

| Argument | Type | Description |
| --- | --- | --- |
| `description` | string | What the test should cover (required) |
| `pageUrl` | string | Page the test starts on (default: `baseURL` / `webServer.url` from config) |
| `testDir` / `file` | string | Where to write the spec (default: detected `testDir` + `generated/<slug>.spec.ts`); `file` must end in `.spec.*` or `.test.*` |
| `write` | boolean | Write the file to disk (default `true`) |
| `overwrite` | boolean | Replace an existing spec at the target path; only specs this tool generated can be replaced |
| `liveInspect` | boolean | Cross-check selectors against the live page (default on when a URL is known) |
| `steps` | array | **Walk the flow**: up to 30 steps in the [`actions`](#page-state-signed-in-pages-headers-and-steps) format, run on the live page before anything is written |
| `assertScope` | string | With `steps`: CSS scope of the end-state accessibility snapshot (default `body`) |
| `storageState` | string | With `steps`: signed-in session for the walk; the spec uses it too (`test.use`) |
| `verify` / `project` / `timeoutMs` | — | With `steps`: run the written spec once (default `true`), in this Playwright project |
| `projectRoot` / `config` | string | As with the other tools |

**With `steps`**, the tool walks the flow on the live page first. If a step's locator does
not work, it stops there, writes nothing and says which step failed. Otherwise it writes a
spec that replays the steps, asserts the URL path and the accessibility snapshot where the
flow landed (headings only when the snapshot is long), and runs it once:

```ts
test('rename in settings', async ({ page }) => {
  await page.goto('http://localhost:3000/account');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByLabel('Nickname').fill('Ada');

  // End state
  await expect(page.locator("dialog")).toMatchAriaSnapshot(`
    - dialog:
      - heading "Settings" [level=2]
      - text: Nickname
      - textbox "Nickname": Ada
      - button "Save settings"
  `);
});
```

**Without `steps`**, it reads the agent's recent changes (`git status`, falling back to `git diff HEAD~1`,
then recent mtimes), extracts the locators those files actually declare
(`data-testid`, `getByRole`, `aria-label`, `placeholder`, `id`, `name`, element text),
ranks verified-live selectors first, writes a spec built from them, and reports each
selector with its source `file:line`. When the source has no usable selectors, it uses the
verified locators from the live page that best match the description.

### `compare-visual-state`

| Argument | Type | Description |
| --- | --- | --- |
| `url` | string | Page to capture (required) |
| `name` | string | Baseline id, e.g. `checkout-page` (letters, digits, `. _ -`) |
| `action` | `compare` \| `baseline` | `compare` (default) diffs; `baseline` re-captures the reference |
| `selector` | string | Capture just this element |
| `fullPage` | boolean | Capture the full scrollable page |
| `tolerance` | number | Percent of pixels that may differ (default `0.1`) |
| `pixelThreshold` | number | Per-pixel channel delta considered different (default `60`) |
| `waitUntil` / `waitFor` / `timeoutMs` | — | As with `inspect-page` |
| `storageState` / `headers` / `actions` / `viewport` | — | [Page state](#page-state-signed-in-pages-headers-and-steps) |

The first call saves a baseline under `.pw-mcp/visual/` (add that to `.gitignore`, or
commit it for CI comparisons). Later calls report changed-pixel counts, **merged
regions** (`(x, y) 120×40 — 1,200 px`), the **average color shift** ("blue → red"),
and write a red-highlighted diff image for review.

### `diagnose-flaky`

| Argument | Type | Description |
| --- | --- | --- |
| `testFiles` | string[] | Tests to diagnose (`file:line` supported). Defaults to the tests that failed in the most recent run |
| `runs` | number | Repetitions, `2–10` (default `3`) |
| `isolate` | boolean | Also tell parallelism bugs from flakiness: repeat fully parallel (`workers` default `4`), then repeat the failing tests with one worker |
| `order` | boolean | Also run the target files in `runs` random orders with one worker (Playwright 1.64+ `--shuffle`), replay a failing order, and name the test it relies on or is broken by |
| `separateProcesses` | boolean | Start a fresh Playwright process per repetition instead of one `--repeat-each` process (slower; for flakes that depend on global setup or a cold start) |
| `browser` / `headed` / `workers` / `config` | — | As with `run-test` |
| `timeoutMs` | number | Hard wall-clock limit **per repetition** (default `120000`); one `--repeat-each` process gets this × `runs` |
| `projectRoot` | string | Project directory |

All repetitions run in **one Playwright process** with `--repeat-each` and
`--retries=0`, so each attempt is honest evidence and the browser and workers
start once instead of once per run (about 25% faster on the integration fixture,
more for suites with expensive setup). A small extra reporter records every
attempt, because Playwright's JSON report keeps only one result per test.

The verdict is **per test**: a table of passes, failures, duration spread and
first error for each test, plus the verdict block for the worst one:

- **❌ CONSISTENTLY FAILING** — failed every run (same error → reproducible bug,
  different errors → still broken, just noisy). Fix it; it is not flaky.
- **⚠️ FLAKY** — some runs passed. Includes `N of M` counts and whether the
  failures share one signature (real intermittent bug) or vary (timing/environment
  instability).
- **✅ NOT REPRODUCING** — passed every re-run; the original failure was one-off.

With `isolate: true` a second table compares each failing test **in parallel**
and **alone**:

| Reading | Meaning |
| --- | --- |
| 🔀 fails only in parallel | Passes every run alone: shared state between tests (same account, DB rows, files, ports). Give each worker its own data or run the file serially |
| ⏱️ flaky even alone | The race is inside the test or the app: missing `await`, asserting before the UI settles |
| ❌ fails alone too | Not a parallelism problem; a real bug |

With `order: true` a third section runs the spec files (not just the failing
lines) in random orders with one worker and `--fully-parallel`, so every test is
scheduled on its own. A test that fails in some orders is replayed in a failing
order; if it fails again it is read as **🔗 order dependent**, otherwise as
**flaky regardless of order**:

```
| `tests/cart.spec.ts:10` checkout lists the book | 2/3 | `4` | 🔗 order dependent … |

**checkout lists the book**
- Relies on: `adds a book to the cart` (ran before it in every passing order, after it in a failing one)
- Reproduce: `npx playwright test tests/cart.spec.ts --workers=1 --fully-parallel --retries=0 --shuffle=4`
```

This is the failure that otherwise reads as "passes alone, fails in the suite".
Set `PW_MCP_SHUFFLE_SEEDS=4,7` on the server to replay given orders, for
example to check a fix.

Each repetition is recorded in the run history, and the last failing run is
stored, so `analyze-history` and `get-failure` work right afterwards.

### `audit-accessibility`

| Argument | Type | Description |
| --- | --- | --- |
| `url` | string | Page to audit (required) |
| `standard` | `wcag2a` \| `wcag2aa` \| `wcag21aa` \| `wcag22aa` \| `best-practice` \| `all` | Rule set (default `wcag22aa`: WCAG 2.0–2.2 level A and AA; `best-practice` adds axe's extra rules; `all` runs every rule) |
| `minImpact` | `critical` \| `serious` \| `moderate` \| `minor` | Hide violations below this impact |
| `selector` | string | Audit only this part of the page |
| `waitFor` / `waitUntil` / `timeoutMs` | — | As with `inspect-page` (`waitUntil` default `load`, `timeoutMs` default `60000`) |
| `storageState` / `headers` / `actions` / `viewport` | — | [Page state](#page-state-signed-in-pages-headers-and-steps) |

axe-core (the engine behind Lighthouse's accessibility score) is bundled and
evaluated inside the page, so a Content-Security-Policy does not block it.
Example output:

```
## ♿ 3 accessibility violations (2 critical, 1 serious)

### 1. critical · `button-name`: Buttons must have discernible text (WCAG 4.1.2)
1 element · https://dequeuniversity.com/rules/axe/4.14/button-name
- `getByTestId('go')`: Element does not have inner text that is visible to screen readers

### 3. serious · `color-contrast`: Elements must meet minimum color contrast ratio thresholds (WCAG 1.4.3)
- `getByText('Low contrast')`: Element has insufficient color contrast of 2.32 (foreground color: #aaaaaa, …). Expected contrast ratio of 4.5:1
```

It ends with an `@axe-core/playwright` check for the spec, so the page stays fixed.

### `audit-performance`

| Argument | Type | Description |
| --- | --- | --- |
| `url` | string | Page to measure (required) |
| `throttle` | `none` \| `mobile` | `mobile` is Lighthouse's phone preset: 412×823 touch viewport, 4x CPU slowdown, slow 4G. Default `none` (desktop, unthrottled) |
| `cpuSlowdown` | number | Override the CPU slowdown factor (1–20) |
| `runs` | number | Load the page 1–5 times and report the median (default `1`); the LCP range is shown |
| `budgets` | object | `{ lcpMs, cls, inpMs, tbtMs, fcpMs, ttfbMs, transferKb, requests }`, any subset. With budgets the verdict is pass/fail; without, metrics are rated against Google's thresholds |
| `settleMs` | number | Keep observing after load for late images and shifts (default `1500`) |
| `waitFor` / `waitUntil` / `timeoutMs` | — | As with `inspect-page` (`waitUntil` default `load`, `timeoutMs` per run, default `60000`) |
| `storageState` / `headers` / `actions` / `routes` / `viewport` | — | [Page state](#page-state-signed-in-pages-headers-and-steps). Clicks and key presses in `actions` are measured as interactions (INP) |

The metrics come from the browser's own performance entries (the same ones Lighthouse and
the `web-vitals` library read) and the bytes from the DevTools protocol, so cross-origin
sizes count too. Example output:

```
## ⚡ 3 of 6 metrics need work (CLS, INP, TBT)

| Metric | Value | Rating |
| --- | --- | --- |
| LCP · largest contentful paint | 412 ms | 🟢 good |
| CLS · cumulative layout shift | 0.109 | 🟠 needs improvement |
| INP · slowest interaction (lab) | 360 ms | 🟠 needs improvement |
| TBT · total blocking time | 306 ms | 🟠 needs improvement |

### What to fix
- **CLS 0.109**: these moved: `getByRole('img', { name: 'Summer sale' })`, `getByRole('button', { name: 'Add to cart' })`. Reserve their space (…)
- **TBT 306 ms** from 2 long task(s), the longest 404 ms: split or defer JavaScript.
- **INP 360 ms** on pointerdown on button: the handler blocks the next paint; yield (…)

### Network
**Transfer:** 302 kB in 4 requests · DOM: 13 nodes · JS heap: 10.0 MB
**Render-blocking:**
- stylesheet `http://localhost:4173/style.css` · 324 ms
```

It ends with a Playwright test that asserts LCP and CLS stay within budget. These are lab
numbers from one headless Chromium; field data (CrUX, RUM) can differ.

### `suggest-fix`

| Argument | Type | Description |
| --- | --- | --- |
| `index` | number | 1-based failure index from the last run (default `1`) |
| `apply` | boolean | Write the fix into the spec (default `false`: return the diff only) |
| `verify` | boolean | After applying, re-run the test and revert the file if it still fails (default `true`) |
| `allowExpectationUpdate` | boolean | Allow applying a changed expected text/value (default `false`, since it can hide a real regression) |
| `candidate` | number | For a strict mode violation, which of the listed matches the test meant (1-based) |
| `url` | string | Heal against this live page instead of the DOM snapshot in the failure trace |
| `storageState` / `headers` | — | For `url`, as in [Page state](#page-state-signed-in-pages-headers-and-steps) |
| `config` / `timeoutMs` / `projectRoot` | — | As with `run-test` |

Three kinds of fix:

- **Ambiguous locator.** A strict mode violation ("resolved to 2 elements") lists each match
  with the unique locator Playwright computed for it. When the broken locator matched by
  substring (`name: 'Save'` hitting *Save* and *Save draft*), the exact-name match is picked
  with `high` confidence. When the matches are equal (the same *Home* link in the header and
  the footer), they are listed and you choose with `candidate`.
- **Locator drift.** The broken locator is read from the error, its words are matched
  (with synonyms such as *btn → button*, *checkout → proceed to checkout*) against every
  element in the DOM at failure, and the best match's verified-unique locator replaces it.
  Confidence is `high` when the match is clear, `medium` otherwise.
- **Changed copy.** For `toHaveText`, `toContainText`, `toHaveValue`, `toHaveTitle`,
  `toHaveURL` and `toHaveAttribute`, it proposes the value the page actually showed. It is
  only applied with `allowExpectationUpdate: true`.

The response is a unified diff. With `apply: true` the file is written only if it has not
changed since the failure, the single test is re-run (same project, no retries), and the
edit is reverted when it is still red. If nothing on the page shares the locator's
distinctive words, it refuses and reports that the element is most likely **missing**.

### `get-run-status`

| Argument | Type | Description |
| --- | --- | --- |
| `runId` | string | Run id from `run-test` with `background: true` (default: the most recent run) |
| `waitSeconds` | number | Wait up to this long (max 55) for the run to finish |
| `cancel` | boolean | Stop the run and kill its browsers |

While running it reports tests done / total and failures so far; once finished it returns
the full `run-test` result, which also becomes the last run for `get-failure` and
`suggest-fix`. The 20 most recent runs are kept in memory.

### `analyze-history`

| Argument | Type | Description |
| --- | --- | --- |
| `view` | `flaky` \| `patterns` \| `slow` \| `trend` \| `commits` \| `test` | `flaky` (default) ranks unstable tests; `patterns` groups failures by kind and normalized error; `slow` lists tests by median duration and flags ones that got slower; `trend` shows failed and flaky executions per day; `commits` names the first bad commit of each failing or flaky test; `test` shows one test's timeline |
| `test` | string | Substring of a test's file or title (filters every view) |
| `lastRuns` | number | How many recent runs to analyze (default `30`) |
| `limit` | number | Max rows (default `15`) |

Every `run-test`, `diagnose-flaky`, `suggest-fix` and `load-report` run appends a line to
`<project>/.playwright-e2e-mcp/history.jsonl` (the folder carries its own `.gitignore`;
nothing leaves the machine; `PW_MCP_HISTORY=0` turns it off). The flaky view separates
tests that flip between pass and fail, tests that started failing and stayed red
(regressed), and tests that failed every run (broken), each with a `PFFP~` timeline.

Each run records the commit it tested (from git locally, from the report's metadata for CI
runs). The `commits` view uses that to say where a test went bad: the first failing or flaky
run after its last streak of passes, with the last good commit and a `git diff` to compare
them.

### `load-report`

| Argument | Type | Description |
| --- | --- | --- |
| `report` | string | A Playwright JSON report inside the project (e.g. `ci-artifacts/results.json`), or a folder of blob-report zips from sharded jobs (merged with the project's `playwright merge-reports`) (required) |
| `traceDirs` | string[] | Folders inside the project where the job's `test-results` artifact was unpacked (default: the report's folder and its parent) |
| `commit` / `branch` | string | Override what the report's metadata says (Playwright records it with `captureGitInfo` or on CI) |
| `record` | boolean | Add the run to the history (default `true`) |
| `timeoutMs` | number | Limit for merging blob reports (default `120000`) |

Download the artifacts first, for example with
`gh run download <run-id> -n playwright-report -D ci-artifacts`. The CI machine's absolute
paths are mapped onto your checkout, so failures point at local files and get-failure can
open each trace. The run becomes the last run, so the usual loop works on it: `get-failure`,
then `suggest-fix` (which re-runs the fix locally), or `diagnose-flaky`.

---

## Installation

Requirements:

- Node.js **≥ 20** (the server is built on MCP SDK v2 — the `2026-07-28` spec line)
- A project with `@playwright/test` installed and browsers available
  (`npx playwright install chromium`)

**No npm account needed** — install straight from GitHub (the `prepare` script
builds `dist/` automatically on install). Pin a release tag: an unpinned
`github:xsignon-secure/E2E` runs whatever is on the default branch at that moment.

```bash
npx -y github:xsignon-secure/E2E#v0.5.0
npm install -D github:xsignon-secure/E2E#v0.5.0 @playwright/test   # or as a project dependency
npx playwright install chromium
```

Or grab the packaged tarball from the repo's **GitHub Releases** page and install
it locally:

```bash
npm install -D https://github.com/xsignon-secure/E2E/releases/download/v0.5.0/playwright-e2e-mcp-0.5.0.tgz
```

Listed in the **official [MCP Registry](https://registry.modelcontextprotocol.io/)** as
`io.github.xsignon-secure/E2E` — registry-aware clients discover it there, and every
`v*` release tag republishes the entry from CI via [`server.json`](server.json).

### MCP client configuration

**Claude Code / generic (project-scoped):**

```json
{
  "mcpServers": {
    "playwright-e2e": {
      "command": "npx",
      "args": ["-y", "github:xsignon-secure/E2E#v0.5.0"],
      "env": { "PW_MCP_PROJECT_ROOT": "/absolute/path/to/your/project" }
    }
  }
}
```

**Claude Desktop / Cursor / Windsurf / Cline:** add the same block to their MCP config file
(Cline: *MCP Servers → Configure*). **Zed** and other clients that take a command: run `npx`
with the arguments `-y playwright-e2e-mcp`.
The server uses its working directory as the project root; set `PW_MCP_PROJECT_ROOT`
when the client launches it somewhere else (e.g. your home directory).

**Codex / VS Code / Copilot CLIs:**

```bash
codex mcp add playwright-e2e -- npx -y github:xsignon-secure/E2E#v0.5.0
code --add-mcp '{"name":"playwright-e2e","command":"npx","args":["-y","github:xsignon-secure/E2E#v0.5.0"]}'
```

Codex's defaults fight this server: the first launch clones the repo and runs
`tsc` (measured 30 s on a cold `npx` cache, against a 10 s
`startup_timeout_sec` default), and a Playwright run with retries beats the 60 s
`tool_timeout_sec` default. Raise both in `~/.codex/config.toml`:

```toml
[mcp_servers.playwright-e2e]
command = "npx"
args = ["-y", "github:xsignon-secure/E2E#v0.5.0"]
startup_timeout_sec = 60
tool_timeout_sec = 600
```

**Claude Desktop (one-click):** download and double-click the `.mcpb` Desktop
Extension attached to the [latest release](https://github.com/xsignon-secure/E2E/releases) —
the bundle ships its own dependencies, so no Node setup is required. On install it
asks you to pick your **project root** (required, no default: choose the project
folder, not your home directory) and wires it
into `PW_MCP_PROJECT_ROOT`, so the tools point at a real project from the first call.

**Claude Code:**

```bash
claude mcp add playwright-e2e -- npx -y github:xsignon-secure/E2E#v0.5.0
```

**Gemini CLI / Qwen Code:** paste the `mcpServers` block above into
`.gemini/settings.json` (Qwen Code: `.qwen/settings.json`) — both speak the same
MCP settings format.

**Freebuff / Codebuff (project-scoped):** this repo ships a committed
[`.agents/mcp.json`](.agents/mcp.json), so opening the checkout in Freebuff
attaches the server workspace-wide — no global config needed. Your own projects
can do the same: drop an `mcp.json` with the block above into their `.agents/`
directory. Freebuff asks you to trust a repository's `.agents/` on first run.

All tools ship MCP **tool annotations** (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`), so clients can show accurate safety prompts
before running anything.

**From a local checkout:**

```json
{
  "mcpServers": {
    "playwright-e2e": {
      "command": "node",
      "args": ["/path/to/playwright-e2e-mcp/dist/index.js"],
      "env": { "PW_MCP_PROJECT_ROOT": "/path/to/your/project" }
    }
  }
}
```

## Hosted endpoint (ChatGPT & remote clients)

Some clients — ChatGPT custom connectors especially — only accept **remote
HTTPS** MCP servers and refuse to spawn a local `npx` process. This repo ships a
Streamable HTTP bridge for exactly that case:

| | |
| --- | --- |
| **Endpoint** | `https://playwright-e2e-mcp.vercel.app/api/mcp` |
| **Transport** | MCP Streamable HTTP (`POST` JSON in, JSON or SSE out) |
| **Auth** | bearer token (`PW_MCP_HTTP_TOKEN`), or OAuth sign-in with that token as the access key (for claude.ai connectors). The deployment at this URL requires one of them; a bridge started without the variable serves only the read-only tools |
| **Source** | [`api/mcp.ts`](api/mcp.ts) → [`src/http.ts`](src/http.ts) |

The bridge runs the *same* `createServer()` as the stdio transport; the SDK
serves every request with a fresh server instance, which is what a serverless
function wants. `test/http-bridge.test.mjs` drives the real Node adapter over
`node:http` so a broken bridge fails in CI, not in ChatGPT.

**This demo deployment is token-protected.** `https://playwright-e2e-mcp.vercel.app`
runs on the maintainer's account and has `PW_MCP_HTTP_TOKEN` set, so a request
without `Authorization: Bearer <token>` (or an OAuth sign-in with it) gets
`401 {"error":"unauthorized"}`. Nothing is held back: the same bridge is free to
host yourself on a free Vercel account, with your own token:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fxsignon-secure%2FE2E&env=PW_MCP_HTTP_TOKEN&envDescription=A%20random%20secret%20of%2016%2B%20characters%3B%20clients%20send%20it%20as%20a%20bearer%20token%20or%20type%20it%20to%20sign%20in&project-name=playwright-e2e-mcp)

A serverless function has no browser, so for running and fixing your own tests
the free local install (`npx -y playwright-e2e-mcp init`) is the better route.

**Open vs. token-protected.** With `PW_MCP_HTTP_TOKEN` set (at least 16
characters; use a random value) every tool is served to clients that send
`Authorization: Bearer <token>`, and every other request gets `401`. Without that
variable anyone who reaches the URL can call the bridge, so it degrades to
`list-tests` and `get-failure` in restricted mode: `list-tests` scans sources
instead of running `playwright test --list` (which would execute the project's
config), callers cannot pick another `projectRoot`, and nothing spawns a process,
drives a browser or writes a file. Child processes started over HTTP get only an
allowlisted environment. `PW_MCP_ALLOWED_HOSTS` (comma separated, `*` for any)
limits the accepted `Host` header; without a token and without that variable,
only `localhost` names and the deployment's own Vercel hostnames are accepted
(DNS-rebinding protection).

**Add it to ChatGPT:** Settings → Connectors → turn on **Advanced → Developer
mode** → *Create custom connector* → paste the endpoint above. Authentication
**None** only works against a bridge with no token (read-only tools), so for this
deployment choose the connector's **API key** authentication and send
`Authorization: Bearer <token>` — or point the connector at your own deployment
with `PW_MCP_HTTP_TOKEN` unset.

**Add it to claude.ai (or Claude Desktop's connectors):** Settings → Connectors →
*Add custom connector* → paste the endpoint above and leave the OAuth fields
empty. Claude registers itself and opens a sign-in page; type the deployment's
access key (the value of `PW_MCP_HTTP_TOKEN`) and press **Allow access**. The
bridge is its own small OAuth 2.1 server (discovery, dynamic client
registration, authorization code with PKCE S256, refresh tokens) and keeps no
state: client ids, codes and tokens are signed with a key derived from
`PW_MCP_HTTP_TOKEN`, access tokens last an hour and refresh tokens 30 days, and
changing `PW_MCP_HTTP_TOKEN` signs every connected client out. The sign-in page
shows which site will receive access, so only type the key when that is the
app you are connecting. Source: [`src/oauth.ts`](src/oauth.ts); the
`/.well-known/oauth-*` and `/oauth/*` paths reach the function through the
rewrites in [`vercel.json`](vercel.json).

To self-host the open, read-only variant, deploy this repo with
`PW_MCP_HTTP_TOKEN` unset; nothing else changes.

Codex can also take the remote transport instead of spawning `npx`, if you'd
rather not ship Playwright to every machine. Point it at the token through an
environment variable so the secret stays out of the config file:

```bash
export PW_MCP_HTTP_TOKEN=…   # ask the operator for the value
codex mcp add playwright-e2e-remote --url https://playwright-e2e-mcp.vercel.app/api/mcp \
  --bearer-token-env-var PW_MCP_HTTP_TOKEN
```

**What to expect:** `list-tests` works and reports the specs bundled with the
deployment. Even with a token, tools that spawn a browser (`run-test`,
`inspect-page`, `validate-selector`, `diagnose-flaky`, …) cannot download
Chromium in a serverless function, so they return `NO_PLAYWRIGHT` with a note
that points to the local install. Use the stdio install for real runs; the
hosted endpoint is for discovery and for clients that cannot run local
processes.

```bash
# verify the handshake without any client (the live deployment needs the token;
# drop the authorization header and it answers 401 instead)
curl -X POST https://playwright-e2e-mcp.vercel.app/api/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $PW_MCP_HTTP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

Redeploy after a change: merge to `main`. Vercel's Git integration deploys
every push, so there is no token to manage and no CLI step — watch the
`Vercel` commit status for the deployment result.

## CI: GitHub Action and `ci` command

The same diagnosis runs without an agent. `playwright-e2e-mcp ci` runs the
suite (auto-retry once, so flaky tests are reported as flaky, not failed),
optionally drafts `suggest-fix` diffs and a flaky verdict for the failures, and
writes one Markdown report to stdout, to `--output`, and to the GitHub job
summary when `GITHUB_STEP_SUMMARY` is set. Exit code `0` passed, `1` tests
failed, `2` the run itself failed.

```bash
npx -y playwright-e2e-mcp ci --flaky-runs 3 --suggest 2 --output report.md
npx -y playwright-e2e-mcp ci --help
```

As a GitHub Action, it adds the report to the job summary and keeps one PR
comment up to date when the run fails:

```yaml
permissions:
  contents: read
  pull-requests: write   # only for the PR comment
steps:
  - uses: actions/checkout@v6
  - uses: actions/setup-node@v6
    with: { node-version: 24 }
  - run: npm ci && npx playwright install --with-deps chromium
  - uses: xsignon-secure/E2E@v0.5.0
    with:
      flaky-runs: 3      # 0 skips the flaky verdict
      suggest: 2         # suggest-fix diffs for the first 2 failures
      # args: --browser chromium tests/checkout
```

Inputs: `project-root`, `args`, `flaky-runs`, `suggest`, `comment`,
`fail-on-failure`, `version`, `github-token`. Outputs: `exit-code`, `report`.

## Docker

```bash
docker build -t playwright-e2e-mcp .
docker run -i --rm -v "$PWD:/work" playwright-e2e-mcp            # stdio MCP server
docker run --rm -v "$PWD:/work" playwright-e2e-mcp ci            # CI report
```

The image is based on `mcr.microsoft.com/playwright:v1.63.0-noble`, so its
browsers match Playwright 1.63. Mount your project at `/work`; its own
`node_modules` provide `@playwright/test`.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PW_MCP_PROJECT_ROOT` | server cwd | Default project root for every tool |
| `PW_MCP_TOOLS` | all | Which tools to expose, as tool names and/or profiles, comma separated (same as the `--tools=` flag). Profiles: `core` (run, status, failure, fix, flaky, list), `triage` (run, status, failure, CI report, flaky, history, list), `inspect` (page, selector, accessibility, performance, visual), `author` (list, page, selector, generate, run). All fourteen tool definitions cost about 9k tokens of context per request; `core` costs about 2.3k |
| `PW_MCP_STORAGE_STATE` | — | Default `storageState` file (inside the project) for the page tools |
| `PW_MCP_SHUFFLE_SEEDS` | random | Comma-separated seeds for `diagnose-flaky`'s `order` pass, to replay the orders a diagnosis reported |
| `PW_MCP_HISTORY` | on | `0` stops recording runs to `.playwright-e2e-mcp/history.jsonl` |
| `PW_MCP_ALLOWED_ROOTS` | — | Extra directories a caller may pass as `projectRoot` (`:`-separated, `;` on Windows). Anything outside these and the default root is rejected |
| `PW_MCP_HTTP_TOKEN` | — | HTTP bridge only: bearer token (16+ characters) that unlocks all tools (see above) |
| `PW_MCP_ALLOWED_HOSTS` | localhost + Vercel hostnames when there is no token | HTTP bridge only: comma-separated `Host` allowlist; `*` accepts any |
| `PW_MCP_PASSTHROUGH_ENV` | — | HTTP bridge only: comma-separated extra variables passed to test runs (e.g. `BASE_URL`) |
| `PW_MCP_MAX_CHILDREN` | `4` | HTTP bridge only: how many test runs and browser probes may run at once |
| `PW_MCP_BLOCK_PRIVATE_URLS` | off (on for the HTTP bridge) | `1` makes the URL tools refuse loopback, private-network and cloud-metadata addresses, including redirects and subresources |
| `LOG_LEVEL` / `MCP_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent`; `LOG_LEVEL` wins when both are set |
| `LOG_FORMAT` / `MCP_LOG_FORMAT` | `text` | `text`, or `json` (also `ndjson`) for one structured JSON object per line — ready for a log ingester |

Logs always go to **stderr** — stdout is reserved for the MCP protocol. Unrecognized values
fall back to the default, so a typo in `LOG_LEVEL` logs at `info` and one in `LOG_FORMAT`
logs as text rather than silencing the server. With `LOG_FORMAT=json` each line is a single
object (`time`, `level`, `message` plus context):

```json
{"time":"2026-10-07T08:00:00.000Z","level":"info","message":"server ready","name":"playwright-e2e-mcp"}
```

## Typical workflow

1. `run-test` `{ "testFiles": ["tests/checkout.spec.ts"] }`, or `{ "background": true }`
   for a long suite and `get-run-status` `{ "waitSeconds": 30 }` until it finishes. For a
   failure from CI, download the job's artifacts and call `load-report`
   `{ "report": "ci-artifacts/results.json" }` instead.
2. `get-failure` `{ "index": 1 }` to read the code frame, expected/actual, **the DOM
   snapshot at failure**, the failed network requests and the page's console errors.
3. `suggest-fix` `{ "index": 1 }` for a locator or copy change: review the diff, then
   `{ "index": 1, "apply": true }` to write it and verify with a re-run. If it reports the
   element is missing, fix the app, not the test.
4. For anything it cannot patch: `inspect-page` `{ "url": "…", "view": "locators" }`
   (add `storageState` or `actions` to reach the right screen), then `validate-selector`
   to prove the new locator before editing.
5. If a failure looks intermittent: `diagnose-flaky` `{ "runs": 3 }` for fresh evidence,
   and `analyze-history` to see how the test behaved across earlier runs
   (`{ "view": "commits" }` names the commit where it went bad).
6. After changing CSS or components: `compare-visual-state` `{ "url": "…", "name": "checkout" }`.
7. Re-run **only what failed** with `run-test` `{ "lastFailed": true }` until green.

To write a new test, find the locators with `inspect-page` `{ "view": "locators" }`, then call
`generate-e2e-test` with a `description` and the `steps` of the flow; it walks them on the live
page, writes the spec and runs it once. To check a page's speed or accessibility, use
`audit-performance` and `audit-accessibility`.

## Benchmark

[`bench/token-benchmark.mjs`](bench/token-benchmark.mjs) breaks a checkout button's test id
on a storefront page and fixes it two ways: with this server (`run-test` → `suggest-fix` →
apply) and with Playwright MCP plus a shell (`playwright test`, `browser_navigate` +
`browser_snapshot`, edit, re-run). Latest result ([full output](bench/RESULTS.md)):

| Step | playwright-e2e-mcp | Playwright MCP + shell |
| --- | ---: | ---: |
| Tool definitions (sent with every request) | 4,565 | 4,726 |
| Run the failing test | 246 | 325 |
| Find the element / propose the fix | 260 | 2,286 |
| Apply + verify (re-run) | 257 | 34 |
| **Total for one fix** | 5,328 | 7,371 |

Tokens are characters ÷ 4. The Playwright MCP route is a lower bound: it assumes the agent
picks the right locator from the snapshot on the first try, which the server does for it here.

## Edge cases handled

| Situation | Behaviour |
| --- | --- |
| No Playwright installed | `NO_PLAYWRIGHT` error with the exact install commands for your package manager |
| Dev server not running | Failure classified `server-unreachable` / `SERVER_NOT_RUNNING` with a "start your dev server" hint (and `webServer` advice) |
| Test exceeds `timeoutMs` | Process **group** is killed (SIGINT→SIGKILL on POSIX, `taskkill /T /F` on Windows) and partial results are returned |
| Browser crashes | Classified `browser-crash` with retry / reinstall guidance |
| Windows backslashes | All paths normalized lexically (`C:\a\..\b` → `C:/b`); unit-tested on both platforms |
| Flaky tests | Failing tests are automatically retried once (`--retries=1`) before being reported; passes surface as **flaky** with a stability warning; `diagnose-flaky` decides flaky-vs-broken with multi-run evidence |
| Trace/DOM context | `--trace=retain-on-failure` is passed automatically, so `get-failure` can show the exact DOM at the moment of failure — plus the failed network requests (`*.network` logs) and console errors from the same trace |
| Slow re-runs after a fix | `run-test` with `lastFailed: true` re-runs only the tests that failed last time (`--last-failed`) |
| Several `playwright.config` files | Returns a numbered menu (`MULTIPLE_CONFIGS`); pick with `config: "2"` or a path |
| Syntax error in a spec | `SYNTAX_ERROR` with file:line; nothing crashes; `list-tests` falls back to a source scan |
| MCP client disconnects | Per-request `AbortSignal` kills the run; stdin end triggers shutdown, and every tracked child tree is force-killed (`killActiveChildren`) |
| Disk full | `ENOSPC` detected → `DISK_FULL` with a "free space" hint; logging never throws |
| Malicious paths | `../../etc/passwd`, absolute paths outside the root, a `projectRoot` outside the allowed roots, symlinks that leave the root, URLs and null bytes are rejected with `INVALID_PATH`; extra CLI args must be allowlisted Playwright flags |

## Security notes

- **No shell**: Playwright is spawned as `node <playwright/cli.js> …` with an argument
  array — no command interpolation. Extra `args` are limited to an allowlist of
  Playwright flags, each with a checked value (`--flag=value`), so a caller cannot
  swap in another `--config` or `--output` or hand git an option through
  `--only-changed`. Paths with a segment starting with `-` are rejected, so a test
  file name cannot be read as a flag.
- **Path sandbox**: user paths must stay inside the project root, checked lexically
  and again with symlinks resolved. A caller-supplied `projectRoot` must sit inside
  `PW_MCP_PROJECT_ROOT` (or a `PW_MCP_ALLOWED_ROOTS` entry).
- **Generated code**: `generate-e2e-test` only writes `*.spec.*` / `*.test.*` files,
  only overwrites specs whose header it wrote itself, never writes through a symlink,
  and escapes every value it puts into strings or comments.
- **HTTP bridge**: read-only tools unless `PW_MCP_HTTP_TOKEN` is set; child processes
  started over HTTP get only an allowlisted environment (`PATH`, `HOME`, temp dirs,
  locale, `CI`, `PLAYWRIGHT_*`, `npm_config_*` without embedded credentials, plus
  anything in `PW_MCP_PASSTHROUGH_ENV`), at most `PW_MCP_MAX_CHILDREN` run at once
  (a disconnected client frees its slot immediately), and internal error messages
  are not returned to clients. The allowlist only covers the child's own
  environment: test code runs as the same OS user, so on Linux it could still read
  the server's startup environment from `/proc`. That is why only token holders
  can run project code; keep other secrets out of the bridge's environment, or run
  it under a separate user.
- **SSRF guard**: on the HTTP bridge (or with `PW_MCP_BLOCK_PRIVATE_URLS=1`) the URL tools
  refuse hosts that resolve to loopback, private, link-local/metadata or reserved
  addresses, and route the browser through a local proxy that applies the same check
  to every redirect hop and subresource; IPv6 forms that embed an IPv4 address
  (mapped, NAT64, 6to4, Teredo) are blocked too, and WebRTC UDP is disabled so a
  page cannot reach the network around the proxy. It is off for stdio by default because
  opening `http://localhost` dev servers is what these tools are for.
- **Cleanup**: temp report/script files are written to the OS temp dir and removed;
  child processes are tracked and killed on shutdown. Trace decompression has one
  size budget per archive, and PNGs are capped at 16,384 px per side and 50 M pixels.

## Development

```
src/
├── index.ts            # bin entry point (--version/--help, main-module guard)
├── server.ts           # McpServer setup, tool registration, shutdown handling
├── tools/              # the fourteen tools, the probe script + shared plumbing
├── prompts.ts          # fix-failing-test, triage-flaky-tests
├── utils/              # playwright-runner, report-parser, project-detector, path-utils,
│                       # logger, trace-reader (trace.zip → DOM/network/console),
│                       # image-diff (PNG codec + pixel diff), change-analyzer,
│                       # locator-expr, run-history, run-registry
└── types/              # shared interfaces and the ErrorKind taxonomy
```

Built on **`@modelcontextprotocol/server` v2** (the `2026-07-28` MCP spec line) with
Zod v4 standard schemas; every tool declares spec tool annotations.

```bash
npm install
npm run build   # tsc → dist/ (zero errors)
npm test        # build + test/run-tests.mjs (unit tests, any Node ≥20)
npm run e2e     # build + e2e/run.mjs: live MCP ↔ Playwright integration suite
npm run mcpb    # build + bundle dist/ into playwright-e2e-mcp-<version>.mcpb (+ .sha256)
npm run mcpb:smoke   # ...then install that bundle in a temp dir, launch it and assert the handshake
npm run mcpb:sign    # ...then sign it with MCPB_CERT/MCPB_KEY → <version>.signed.mcpb
npm run skill:zip    # just the archive: dist-skill/playwright-e2e-mcp.zip
npm run skill:package # the uploadable folder: ../agensi-skill-<version>/ (skill copy, README, zip)
npm run skill:check  # build, then fail if a packaged copy has drifted from skill/
```

Tests cover the report parser (sample Playwright JSON, trace attachments), path utils
(Windows and macOS paths, sandboxing), the project detector (temp-dir fixtures: config
discovery, multiple configs, missing install, test-file scanning), the shared tool
helpers, the **trace reader** (synthetic trace.zip: error, failed action, DOM snapshot,
`*.network` failed-request parsing, console error/warning events), the **image diff**
(PNG round-trip, regions, color shift, dimension changes), the **change analyzer**
(selector extraction, git + mtime paths), the **flaky verdict logic**
(failure signatures, CONSISTENTLY FAILING / FLAKY / NOT REPRODUCING / NO TESTS RAN,
per-test grouping of repeat attempts and the parallel-vs-alone reading), the `ci`
argument parser and tool profiles,
the **HTTP bridge** (token, restricted mode, Host allowlist), the **security
regressions** (sandbox escapes, argument smuggling, symlink writes, code injection,
SSRF ranges, env scrubbing, decode limits), the `.mcpb` manifest, the `.mcpb` zip
extractor, the **skill package** (byte-identical rebuilds, a CRLF checkout hashing the
same, refusal of junk/binary/symlinks, and drift detection between `skill/` and a
packaged copy), and the MCP config files.

### Integration suite (`npm run e2e`)

Unit tests prove the logic; the integration suite proves the loop. It boots the real
server over stdio against a live fixture app and a Playwright project under
`e2e/fixture/`, then drives it exactly like an MCP client and asserts ~40 behaviours
that only appear end-to-end:

- initialize handshake, 14 tools, 2 prompts, spec tool annotations and object input schemas,
- verified locators, locator validation, signed-in pages (`storageState`) and page steps,
- background runs with progress, run history views, and `suggest-fix` healing a drifted
  locator and an ambiguous one, verifying each with a re-run (and refusing when the
  element is missing),
- Web Vitals with budgets and phone throttling, and network mocks that force error and
  empty states,
- live DOM inspection, CSS selector validation (matches, zero matches, engine
  syntax, parse errors), dead-server detection,
- visual regression: baseline → unchanged compare → `blue → red` diff detection,
- `run-test` pass/fail/`lastFailed` stats and meta lines,
- `get-failure` trace diagnostics: DOM at failure, the 404 network request,
  the `console.error` message, diagnosis and next steps,
- auto-retry turning a first-run failure into `PASSED (1 flaky)`,
- `diagnose-flaky` verdict **FLAKY** (2 of 3 runs) with retries disabled, in one
  `--repeat-each` process, and `isolate` reading a shared-slot test as "fails only in parallel",
- `--tools=` profiles trimming `tools/list`, and the `ci` command's exit code, report,
  `--output` file and GitHub job summary,
- `generate-e2e-test` writing its scaffold, plus error paths
  (missing test path, unknown tool, unreachable server).

First run needs the browser once: `npx playwright install chromium`.
CI runs the suite on Ubuntu and Windows (see `.github/workflows/ci.yml`).

### Signing the bundle

```bash
MCPB_CERT=~/signing/cert.pem MCPB_KEY=~/signing/key.pem npm run mcpb:sign
```

Signing appends a PKCS#7 signature block to the bundle, so the signed file is
*the reproducible bundle plus that block*. That ordering is the point: the bytes
CI proved identical across platforms stay inside the signed file, and
`mcpb unsign` returns them exactly. `scripts/sign-mcpb.mjs` asserts that round
trip on every run and deletes its output if it fails, which is what keeps
`<version>.signed.mcpb` tied to `<version>.mcpb`.

The private key is read from a path you pass in (`--cert`/`--key` or
`MCPB_CERT`/`MCPB_KEY`) and never from the repository — keep it outside version
control, and back it up: the same key across releases is what makes the signer
recognisable.

What signing does and does not buy you is decided by the certificate, not by
this script. `mcpb verify` and `mcpb info` accept a signature only when the
certificate chains to something in the OS trust store, so with a self-signed
certificate a host still reports **Not signed** — the signature is real
integrity and key continuity, verifiable by the fingerprint the script prints,
but not third-party identity. A certificate issued by a public CA, or an
internal one installed on your machines, is what makes hosts report it as
signed.

### Assembling a release

```bash
npm run mcpb && npm pack                  # the bundle, then the npm tarball
npm run release:assemble -- --tag v0.2.3  # sign, checksum and write the notes
npm run release:publish -- --tag v0.2.3 --assets dist-release/assets \
  --title-file dist-release/RELEASE_TITLE.txt \
  --body-file dist-release/RELEASE_BODY.md --download dist-release/downloaded
npm run release:verify -- v0.2.3 --dir dist-release/downloaded
npm run release:publish -- --tag v0.2.3 --publish
```

Pushing a `v*` tag runs exactly that sequence in
`.github/workflows/release.yml`. The release used to be assembled by hand, and
the notes were written from what those commands printed: every hash in them was
a copy, and nothing compared the bundle hash printed there with the bundle that
shipped.

`scripts/assemble-release.mjs` stages the whole release into
`dist-release/assets/`: the bundle and its sidecar, the **signed** bundle and the
signing certificate when a key is configured, the npm tarball, the skill package
built by the same writer as `npm run skill:zip`, and `SHA256SUMS.txt` covering
every file it staged. It empties that directory first, so a file left over from
an earlier run cannot be hashed and published as if this run had produced it.

The notes are half written, half generated. `release-notes/<tag>.md` holds the
prose — its H1 becomes the release title and has to name the tag — and the script
appends the asset table, the reproduction recipe carrying the real bundle hash,
the signer and fingerprint, and the commit list. The prose is held to the same
rule: a 64-character hex string in it has to be a hash this release publishes,
and writing an `### Assets` section of your own fails the assembly rather than
shipping a second, staler table. See [release-notes/README.md](release-notes/README.md).

`scripts/publish-release.mjs` fills the release **as a draft**, uploads the
assets, downloads every one of them back and compares it byte for byte, and only
`--publish` makes it public — after `release:verify` has re-derived the release
from the tag. Re-running is safe: a draft this workflow assembled is refreshed in
place, while a release it did not assemble, or one already published, is refused
by name instead of overwritten.

Signing is optional and its absence is stated rather than hidden: without the
`MCPB_KEY` and `MCPB_CERT` repository secrets the release is assembled and
published **unsigned**, with a notice in the run and a line saying so in the
notes. Add both — the private key stays out of the repository and out of the logs:

```bash
gh secret set MCPB_KEY  --repo xsignon-secure/E2E < ~/signing/key.pem
gh secret set MCPB_CERT --repo xsignon-secure/E2E < ~/signing/cert.pem
```

Creating the release and uploading its assets needs `contents: write`, which the
job requests for itself; if it is refused, the run names the setting to change.

### Verifying a published release

```bash
git checkout v0.5.0 && npm ci && npm run mcpb
npm run release:verify -- v0.5.0
```

The release notes promise that the tag rebuilds the published bundle byte for
byte. `scripts/verify-release.mjs` checks that promise from a checkout of the
tag: the published bundle against your fresh build, every checksum the release
publishes (and that nothing shippable is missing from `SHA256SUMS.txt`), a
**signed** bundle against the bytes its signature wraps, the **skill package**
against a rebuild from the same tag, and that the published archive still
extracts with that version's manifest. The skill package is required of a tag
whose tree carries the publishing workflow; older tags predate it, so there it
is checked when present and skipped when not, like the signing certificate.
`.github/workflows/verify-release.yml` runs it on demand for any past tag, and by
itself for a release published by hand. A release assembled by
`.github/workflows/release.yml` runs the same check on its own assets *before*
it is published — GitHub does not raise `release: published` for a release created
with the repository's own token, so the check is a step there rather than a
trigger. The `.tgz` is checked for download integrity only: npm
records the packer's line endings, so a tarball packed locally on another OS is
legitimately different.

### Packaging the agent skill

```bash
npm run skill:package                    # ../agensi-skill-<version>/, ready to upload
npm run skill:zip                        # only the archive: dist-skill/playwright-e2e-mcp.zip
npm run skill:check                      # build, then compare every copy
npm run skill:check -- ../agensi-skill-0.3.0
```

`skill/` is an [Agent Skill](https://agentskills.io/specification) — the
instructions an agent follows to drive this server — and the marketplace gets
the same Markdown as a zip with `playwright-e2e-mcp/` at its root.
`scripts/package-skill.mjs` produces that zip, so the uploaded copy is built
rather than assembled by hand, and it refuses what the marketplace rejects: a
missing `SKILL.md`, a non-text file, a symlink, `Thumbs.db`.

`skill:package` writes the whole folder a release would otherwise assemble by
hand — the skill copy, `skill/README.md` and the archive — to
`../agensi-skill-<version>` (or `--out <dir>`), then verifies it with the same
comparison `check` uses, so a successful exit means the folder really is the
skill tree. It is idempotent: a folder that already matches is left untouched.
A folder that has drifted is refused instead of overwritten, because it may
already be published — bump `version` for a new package, or pass `--force` to
replace that one.

The archive comes from the same deterministic writer as the `.mcpb`, so the
same tree always hashes the same, and text payloads are LF-normalised first:
a CRLF checkout builds the bytes an LF one does. CI runs `skill:check`, generates
a package folder, and uploads the built zip as an artifact
(`.github/workflows/ci.yml`).

**Every release publishes the package too.** Assembling a release builds it from
the release tag and attaches it as `<name>-<version>-skill.zip`, and the
`.github/workflows/release.yml` run downloads that asset back off the draft and
byte-compares it with the build before anything is published. The marketplace
upload is that asset, not a folder someone assembled — a deterministic archive
means "the same build as the tagged release" is an exact statement, and
`release:verify` checks it again against a rebuild from the tag.
`.github/workflows/publish-skill-package.yml` stays for the repair path: run it
by hand to attach or rebuild the package for a release that is missing it.

`skill:check` is the other half of that, and the part that matters when a
package has already been uploaded. It builds twice (the bytes must agree),
reads the archive back and compares its contents with `skill/` file by file,
then compares a packaged copy — `../agensi-skill-<version>` by default, or a
path you pass: the package folder, the bare `playwright-e2e-mcp/` folder, or
the zip on its own. Comparisons are by content, never by archive bytes, because
a zip written by a platform `zip` tool carries real timestamps that say nothing
about whether the Markdown inside it is current. Any file that differs, is
missing or is extra is named on stderr and the command exits 1 — the repository
copy and the uploaded copy are the same document, so an edit to either one
should not be invisible.

### Try the example

With Playwright installed in your project:

```bash
npx playwright test examples/sample-test.spec.ts
```

or ask your agent to call `run-test` with
`"testFiles": ["examples/sample-test.spec.ts"]` — it hits the public
[example.com](https://example.com) page, so it verifies browsers, network and the MCP
pipeline in one shot.

## License

MIT
