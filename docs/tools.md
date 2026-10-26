# Tool reference

[← README](../README.md) · [Hosted endpoint](hosted-endpoint.md) · [Development](development.md)

Every argument of the sixteen tools, with example output. The short list is in the
[README](../README.md#tools).

## Structured results

Every result carries a JSON object (`structuredContent`) next to the Markdown, so an
agent or app can read verdicts, counts and `file:line` positions without parsing text.
All of them have `ok` (`false` when the call failed or the tests it ran failed) and,
on a failed call, `error: { kind, message, hint }`. These tools add their own fields,
described by each tool's `outputSchema`:

| Tool | Fields |
| --- | --- |
| `run-test`, `get-run-status` | `run`: `passed`, `failed`, `flaky`, `skipped`, `durationMs`, `exitCode`, `partial`, `failures[]` (`file`, `line`, `title`, `project`, `kind`, `message`, `tracePath`); `runId` and `status` for background runs |
| `get-failure` | `failure` (as above, plus `expected` and `actual`), `index`, `total` |
| `list-tests` | `tests[]` (`file`, `line`, `title`, `project`), `total`, `truncated` |
| `diagnose-flaky` | `verdict` (the worst one), `tests[]` with `verdict`, `passed`, `failed` per test |
| `suggest-fix` | `fix` (`file`, `line`, `before`, `after`, `kind`, `confidence`, `why`, `alternatives`), `applied`, `verified` |
| `audit-accessibility` | `url`, `violations[]` (`id`, `impact`, `help`, `helpUrl`, `count`) |
| `audit-performance` | `url`, `metrics[]` (`id`, `value`, `unit`, `rating`, `budget`, `overBudget`) |
| `audit-tests` | `findings[]` (`file`, `line`, `rule`, `severity`, `message`, `fix`, `test`), `total`, `truncated`, `applied`, `verified` |
| `bisect-failure` | `status` (`found`, `ambiguous`, `max-steps`, `not-failing`, `good-fails`), `firstBad` (`sha`, `subject`, `author`, `date`, `files`), `steps[]` (`commit`, `verdict`, `note`) |

The schemas add about 2.5k tokens to the tool list. `PW_MCP_OUTPUT_SCHEMAS=0` leaves them
out; results still carry the same fields.

## Page state: signed-in pages, headers and steps

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
| `device` | string | A Playwright device preset such as `iPhone 15`, `Pixel 7` or `iPad Pro 11`: its viewport, user agent, pixel ratio and touch. The engine stays `browser`'s (Firefox has no mobile emulation); `viewport` still overrides the size. An unknown name lists close matches |
| `channel` | `chrome` \| `chrome-beta` \| `msedge` \| `msedge-beta` | Run the installed Google Chrome or Microsoft Edge instead of bundled Chromium (`npx playwright install chrome` or `msedge`). Chromium engine only; not on the hosted endpoint |

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

## `run-test`

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

## `get-failure`

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

## `inspect-page`

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
| `storageState` / `headers` / `actions` / `routes` / `har` / `browser` / `device` / `channel` / `viewport` | — | [Page state](#page-state-signed-in-pages-headers-and-steps) |

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

## `list-tests`

| Argument | Type | Description |
| --- | --- | --- |
| `projectRoot` | string | Project directory |
| `config` | string | Config path or 1-based index |
| `testDir` | string | Restrict scanning to a directory (must stay inside the project) |
| `filter` | string | Case-insensitive substring filter on `file › title` |
| `limit` | number | Max tests returned, default `500` |

Uses `playwright test --list` when Playwright works, and **falls back to a source scan**
(keeping the reason) when the install or a spec file is broken.

## `validate-selector`

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

## `generate-e2e-test`

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

## `compare-visual-state`

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

## `diagnose-flaky`

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

## `audit-accessibility`

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

## `audit-performance`

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

## `suggest-fix`

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

## `get-run-status`

| Argument | Type | Description |
| --- | --- | --- |
| `runId` | string | Run id from `run-test` with `background: true` (default: the most recent run) |
| `waitSeconds` | number | Wait up to this long (max 55) for the run to finish |
| `cancel` | boolean | Stop the run and kill its browsers |

While running it reports tests done / total and failures so far; once finished it returns
the full `run-test` result, which also becomes the last run for `get-failure` and
`suggest-fix`. The 20 most recent runs are kept in memory.

## `analyze-history`

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

## `audit-tests`

| Argument | Type | Description |
| --- | --- | --- |
| `testDir` | string | Audit only this folder (default: the config's `testDir`) |
| `filter` | string | Substring of the file path |
| `minSeverity` | `low` \| `medium` \| `high` | Leave out findings below this (default `low`) |
| `historyRuns` | number | Recent runs of the history to weigh in (default `50`) |
| `limit` | number | Max findings listed (default `50`; the summary counts all) |
| `fix` | boolean | Rewrite the mechanical findings, re-run the touched files, and restore them if the run fails |
| `verify` | boolean | With `fix`: re-run the touched files (default `true`) |
| `config` / `timeoutMs` | — | For the verify run, as with `run-test` |

Reads the spec files (no browser, nothing runs unless `fix` is set) and flags the code that
makes tests pass or fail on timing:

| Rule | Severity | Fixed by `fix: true` |
| --- | --- | --- |
| `hard-wait` (`waitForTimeout`), `sleep` (`setTimeout` promise) | high | no: what to wait for instead is a judgement call |
| `non-retrying-assertion`: `expect(await x.isVisible()).toBe(true)`, `expect(await x.textContent()).toBe(…)`, `count()`, `inputValue()`, `getAttribute()`, `page.title()`, `page.url()` | high | yes: `await expect(x).toBeVisible()`, `toHaveText`, `toHaveCount`, `toHaveValue`, `toHaveAttribute`, `toHaveTitle`, `toHaveURL` |
| `missing-await` on a web-first assertion, `expect.poll` or a page action | high | yes: adds the `await` |
| `focused-test` (`.only`) | high | yes: removes `.only` |
| `force-action`, `networkidle`, `element-handle` (`page.$`, `waitForSelector`), `fragile-selector` (XPath, `nth-child`, hashed class names, long CSS chains), `no-timeout` (`timeout: 0`) | medium | no |
| `hardcoded-url` (`goto('http://localhost…')`), `serial-mode` | low | no |

Files are ranked by their findings weighted by the run history: a file whose tests flipped
between pass and fail ranks above a cleaner-looking one that never flaked, and a finding in
a test that flaked is marked 🔥. Run it before `diagnose-flaky` to see the likely cause, or
in review to stop new flake risks.

## `bisect-failure`

| Argument | Type | Description |
| --- | --- | --- |
| `test` | string | The failing spec file (required) |
| `grep` | string | Test title (or part) inside the file. Better than a `:line` suffix, since lines move between commits |
| `project` | string | Playwright project to run in |
| `good` | string | Commit, tag or ref where the test passed (e.g. `v1.4.0`, `HEAD~30`). Default: the newest commit where the run history saw it pass |
| `bad` | string | Where it fails (default `HEAD`) |
| `repeat` | number | Runs per commit, 1–10; any failure marks the commit bad. Raise it for a flaky failure |
| `maxSteps` | number | Commits to test besides the two ends (default `12`, enough for 4,000 commits) |
| `stepTimeoutMs` | number | Limit for each run (default `180000`) |
| `config` | string | As with `run-test` |

It checks out commits in a temporary `git worktree` (your checkout, branch and uncommitted
changes are untouched), links your installed `node_modules` into it, and runs the test
there with retries off. It first confirms the test fails at `bad` and passes at `good`,
then binary-searches the first-parent history. A commit where the test file does not exist
or the project does not run is skipped, as in `git bisect skip`. The report names the first
bad commit with its author, date, changed files and the failure there, and flags it when
the lockfile changed in the range (every step uses your current dependencies).

## `load-report`

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
