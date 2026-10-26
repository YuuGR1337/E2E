/**
 * Tool 13 — audit-performance: load a page in a real browser and return the
 * lab Web Vitals (LCP, CLS, TBT, INP during `actions`, FCP, TTFB) rated
 * against Google's thresholds or the caller's budgets, what each one is
 * caused by (the LCP element and the elements that shifted, as verified
 * Playwright locators; long tasks; render-blocking and heavy requests) and a
 * budget check to paste into a spec.
 *
 * It takes the same page state as inspect-page (storageState, headers,
 * actions, routes), so signed-in dashboards and later steps of a flow can be
 * measured, and it can emulate a mid-range phone on a slow 4G network.
 * Lab numbers vary between loads, so `runs` reports the median.
 */

import { z } from 'zod';
import type { ElementInfo, ToolContext, ToolResponse } from '../types/index.js';
import { PlaywrightMcpError } from '../types/index.js';
import {
  assertHttpUrl,
  bestLocator,
  describePageState,
  describeRouteHits,
  guard,
  loginHint,
  pageStateShape,
  resolvePageState,
  resolveProjectRoot,
  runBrowserScript,
  toolError,
  toolText,
  type BrowserScriptData,
  type NetworkProfile,
  type PerformanceScan,
} from './shared.js';
import { assertUrlAllowed } from '../utils/url-policy.js';

/**
 * Lighthouse's mobile preset: a mid-range phone (4x slower CPU) on slow 4G
 * (150 ms RTT and 1.6 Mbps, with DevTools' packet-level adjustment).
 */
export const MOBILE_PROFILE: { cpuThrottle: number; network: NetworkProfile; viewport: { width: number; height: number } } = {
  cpuThrottle: 4,
  network: { latencyMs: 562.5, downloadBps: Math.round((1_638.4 * 1024 * 0.9) / 8), uploadBps: Math.round((750 * 1024 * 0.9) / 8) },
  viewport: { width: 412, height: 823 },
};

export type MetricId = 'lcp' | 'cls' | 'inp' | 'tbt' | 'fcp' | 'ttfb';

interface MetricSpec {
  id: MetricId;
  label: string;
  /** "good" ceiling and "poor" floor (Google's Web Vitals / Lighthouse). */
  good: number;
  poor: number;
  unit: 'ms' | 'score';
}

export const METRICS: readonly MetricSpec[] = [
  { id: 'lcp', label: 'LCP · largest contentful paint', good: 2_500, poor: 4_000, unit: 'ms' },
  { id: 'cls', label: 'CLS · cumulative layout shift', good: 0.1, poor: 0.25, unit: 'score' },
  { id: 'inp', label: 'INP · slowest interaction (lab)', good: 200, poor: 500, unit: 'ms' },
  { id: 'tbt', label: 'TBT · total blocking time', good: 200, poor: 600, unit: 'ms' },
  { id: 'fcp', label: 'FCP · first contentful paint', good: 1_800, poor: 3_000, unit: 'ms' },
  { id: 'ttfb', label: 'TTFB · time to first byte', good: 800, poor: 1_800, unit: 'ms' },
];

const budgetsShape = z
  .object({
    lcpMs: z.number().min(0).optional(),
    cls: z.number().min(0).optional(),
    inpMs: z.number().min(0).optional(),
    tbtMs: z.number().min(0).optional(),
    fcpMs: z.number().min(0).optional(),
    ttfbMs: z.number().min(0).optional(),
    transferKb: z.number().min(0).optional().describe('Total bytes over the wire, in kB'),
    requests: z.number().int().min(0).optional(),
  })
  .describe('Fail the audit when a metric exceeds its budget (default: rate against Google thresholds)');

const auditPerformanceInput = z.object({
  url: z.string().describe('Full URL of the page to measure (http/https)'),
  projectRoot: z.string().optional().describe('Project whose Playwright launches the browser (default: server root)'),
  throttle: z
    .enum(['none', 'mobile'])
    .optional()
    .describe("'mobile': phone viewport, 4x CPU slowdown and slow 4G like Lighthouse mobile; 'none' (default): desktop, unthrottled"),
  cpuSlowdown: z.number().int().min(1).max(20).optional().describe('Override the CPU slowdown factor'),
  runs: z.number().int().min(1).max(5).optional().describe('Load the page this many times and report the median (default 1)'),
  budgets: budgetsShape.optional(),
  waitFor: z.string().optional().describe('Wait for this selector first'),
  ...pageStateShape,
  waitUntil: z
    .enum(['load', 'domcontentloaded', 'networkidle'])
    .optional()
    .describe('Navigation wait condition (default load)'),
  settleMs: z.number().int().min(0).max(10_000).optional().describe('Keep observing after load for late paints and shifts (default 1500)'),
  timeoutMs: z.number().int().min(5_000).max(300_000).optional().describe('Limit per run in ms (default 60000)'),
});

export type AuditPerformanceInput = z.infer<typeof auditPerformanceInput>;
export type PerformanceBudgets = z.infer<typeof budgetsShape>;
export const auditPerformanceSchema = auditPerformanceInput;

/* ------------------------------------------------------------------ */
/* Pure helpers (unit-tested)                                          */
/* ------------------------------------------------------------------ */

export type Rating = 'good' | 'needs-improvement' | 'poor';

export function rate(id: MetricId, value: number): Rating {
  const spec = METRICS.find((m) => m.id === id)!;
  if (value <= spec.good) return 'good';
  if (value <= spec.poor) return 'needs-improvement';
  return 'poor';
}

export function metricValue(scan: PerformanceScan, id: MetricId): number | undefined {
  switch (id) {
    case 'lcp':
      return scan.lcpMs;
    case 'cls':
      return scan.cls;
    case 'inp':
      return scan.inpMs;
    case 'tbt':
      return scan.tbtMs;
    case 'fcp':
      return scan.fcpMs;
    case 'ttfb':
      return scan.ttfbMs;
  }
}

function budgetFor(budgets: PerformanceBudgets | undefined, id: MetricId): number | undefined {
  if (!budgets) return undefined;
  return id === 'cls' ? budgets.cls : (budgets as Record<string, number | undefined>)[`${id}Ms`];
}

export function formatMs(ms: number): string {
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(ms >= 10_000 ? 1 : 2)} s` : `${Math.round(ms)} ms`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} kB`;
  return `${bytes} B`;
}

function formatMetric(spec: MetricSpec, value: number): string {
  return spec.unit === 'score' ? value.toFixed(3) : formatMs(value);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Combine several runs: every number is the median of the runs that
 * measured it, and the details (LCP element, resources) come from the run
 * whose LCP is closest to that median.
 */
export function mergeRuns(runs: BrowserScriptData[]): { data: BrowserScriptData; spread?: { lcp: [number, number] } } {
  if (runs.length === 1) return { data: runs[0] };
  const scans = runs.map((run) => run.perf!);
  const pick = (get: (scan: PerformanceScan) => number | undefined): number | undefined => {
    const values = scans.map(get).filter((v): v is number => typeof v === 'number');
    return values.length > 0 ? median(values) : undefined;
  };
  const lcp = pick((s) => s.lcpMs);
  let representative = 0;
  if (lcp !== undefined) {
    let best = Infinity;
    scans.forEach((scan, i) => {
      const distance = Math.abs((scan.lcpMs ?? Infinity) - lcp);
      if (distance < best) {
        best = distance;
        representative = i;
      }
    });
  }
  const base = runs[representative];
  const perf: PerformanceScan = {
    ...base.perf!,
    ttfbMs: pick((s) => s.ttfbMs),
    fcpMs: pick((s) => s.fcpMs),
    lcpMs: lcp,
    cls: Math.round((pick((s) => s.cls) ?? 0) * 1_000) / 1_000,
    tbtMs: Math.round(pick((s) => s.tbtMs) ?? 0),
    inpMs: pick((s) => s.inpMs),
    transferBytes: Math.round(pick((s) => s.transferBytes) ?? 0),
    requests: Math.round(pick((s) => s.requests) ?? 0),
  };
  const lcps = scans.map((s) => s.lcpMs).filter((v): v is number => typeof v === 'number');
  return {
    data: { ...base, perf },
    spread: lcps.length > 1 ? { lcp: [Math.min(...lcps), Math.max(...lcps)] } : undefined,
  };
}

interface MetricRow {
  spec: MetricSpec;
  value?: number;
  rating?: Rating;
  budget?: number;
  overBudget: boolean;
}

export function metricRows(scan: PerformanceScan, budgets?: PerformanceBudgets): MetricRow[] {
  return METRICS.map((spec) => {
    const value = metricValue(scan, spec.id);
    const budget = budgetFor(budgets, spec.id);
    return {
      spec,
      value,
      rating: value === undefined ? undefined : rate(spec.id, value),
      budget,
      overBudget: value !== undefined && budget !== undefined && value > budget,
    };
  });
}

function locatorOf(elements: ElementInfo[], index: number): string | undefined {
  const element = index >= 0 ? elements[index] : undefined;
  if (!element) return undefined;
  return bestLocator(element) ?? element.selector;
}

/** Concrete causes and fixes for the metrics that are not good. */
export function perfFindings(data: BrowserScriptData): string[] {
  const scan = data.perf!;
  const out: string[] = [];
  const blocking = scan.renderBlocking;

  if (scan.lcpMs !== undefined && rate('lcp', scan.lcpMs) !== 'good') {
    const where = locatorOf(data.elements, scan.lcpElement);
    const what = scan.lcpUrl ? `the ${scan.lcpTag ?? 'element'} loading \`${scan.lcpUrl}\`` : `a <${scan.lcpTag ?? '?'}> element`;
    const tips: string[] = [];
    if (scan.lcpUrl) tips.push('preload it or set `fetchpriority="high"`, never `loading="lazy"` above the fold', 'serve it compressed (AVIF/WebP) at display size');
    if (blocking.length > 0) tips.push(`cut the ${blocking.length} render-blocking request(s) listed below`);
    if (scan.ttfbMs !== undefined && rate('ttfb', scan.ttfbMs) !== 'good') tips.push('the server answers slowly, so cache or stream the HTML');
    if (tips.length === 0) tips.push('render it from the HTML rather than after client-side JavaScript');
    out.push(`**LCP ${formatMs(scan.lcpMs)}** is ${what}${where ? ` (\`${where}\`)` : ''}: ${tips.join('; ')}.`);
  }
  if (rate('cls', scan.cls) !== 'good') {
    const moved = scan.shiftElements.map((i) => locatorOf(data.elements, i)).filter((l): l is string => l !== undefined);
    out.push(
      `**CLS ${scan.cls.toFixed(3)}**${moved.length ? `: these moved: ${moved.map((l) => `\`${l}\``).join(', ')}` : ''}. Reserve their space (width/height or aspect-ratio on media, min-height on late content, \`font-display: optional\` or size-adjusted fallbacks for web fonts).`,
    );
  }
  if (rate('tbt', scan.tbtMs) !== 'good') {
    out.push(
      `**TBT ${formatMs(scan.tbtMs)}** from ${scan.longTasks} long task(s), the longest ${formatMs(scan.longestTaskMs)}: split or defer JavaScript${scan.thirdPartyOrigins > 0 ? `, and load the ${scan.thirdPartyOrigins} third-party origin(s) after interaction` : ''}.`,
    );
  }
  if (scan.inpMs !== undefined && rate('inp', scan.inpMs) !== 'good') {
    out.push(`**INP ${formatMs(scan.inpMs)}**${scan.inpTarget ? ` on ${scan.inpTarget}` : ''}: the handler blocks the next paint; yield (\`await scheduler.yield()\`) or move work off the main thread.`);
  }
  if (scan.fcpMs !== undefined && rate('fcp', scan.fcpMs) !== 'good' && blocking.length > 0 && !out.some((l) => l.startsWith('**LCP'))) {
    out.push(`**FCP ${formatMs(scan.fcpMs)}**: ${blocking.length} render-blocking request(s) delay the first paint; inline critical CSS and \`defer\` scripts.`);
  }
  return out;
}

export function budgetCheck(url: string, budgets: PerformanceBudgets | undefined): string {
  const lcp = budgets?.lcpMs ?? 2_500;
  const cls = budgets?.cls ?? 0.1;
  return [
    '```ts',
    "test('stays within the performance budget', async ({ page }) => {",
    `  await page.goto(${JSON.stringify(url)});`,
    '  const vitals = await page.evaluate(() => new Promise<{ lcp: number; cls: number }>((resolve) => {',
    '    let lcp = 0;',
    '    let cls = 0;',
    "    new PerformanceObserver((list) => { for (const e of list.getEntries()) lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });",
    "    new PerformanceObserver((list) => { for (const e of list.getEntries() as any[]) if (!e.hadRecentInput) cls += e.value; }).observe({ type: 'layout-shift', buffered: true });",
    '    setTimeout(() => resolve({ lcp, cls }), 1_500);',
    '  }));',
    `  expect(vitals.lcp).toBeLessThan(${lcp});`,
    `  expect(vitals.cls).toBeLessThan(${cls});`,
    '});',
    '```',
  ].join('\n');
}

const ICON: Record<Rating, string> = { good: '🟢 good', 'needs-improvement': '🟠 needs improvement', poor: '🔴 poor' };

export function renderPerformance(
  url: string,
  data: BrowserScriptData,
  options: {
    budgets?: PerformanceBudgets;
    profile: string;
    runs: number;
    spread?: { lcp: [number, number] };
    stateLine?: string;
    routeLines?: string[];
  },
): string {
  const scan = data.perf!;
  const rows = metricRows(scan, options.budgets);
  const measured = rows.filter((r) => r.value !== undefined);
  const budgets = options.budgets;
  const overBudget: string[] = rows.filter((r) => r.overBudget).map((r) => r.spec.id.toUpperCase());
  if (budgets?.transferKb !== undefined && scan.transferBytes / 1_000 > budgets.transferKb) overBudget.push('transfer size');
  if (budgets?.requests !== undefined && scan.requests > budgets.requests) overBudget.push('request count');
  const weak = measured.filter((r) => r.rating !== 'good');

  const lines: string[] = [];
  if (budgets) {
    lines.push(
      overBudget.length > 0
        ? `## ❌ ${overBudget.length} performance budget${overBudget.length === 1 ? '' : 's'} exceeded (${overBudget.join(', ')})`
        : '## ✅ Within every performance budget',
    );
  } else if (weak.length === 0) {
    lines.push('## ✅ All measured Web Vitals are good');
  } else {
    lines.push(`## ⚡ ${weak.length} of ${measured.length} metrics need work (${weak.map((r) => r.spec.id.toUpperCase()).join(', ')})`);
  }
  lines.push('');
  lines.push(
    `**URL:** ${url}${data.finalUrl && data.finalUrl !== url ? ` → ${data.finalUrl}` : ''}  |  **Profile:** ${options.profile}  |  **Runs:** ${options.runs}${options.runs > 1 ? ' (median)' : ''}`,
  );
  if (options.stateLine) lines.push(`**Page state:** ${options.stateLine}`);
  if (data.actionsDone?.length) lines.push(`**Steps run:** ${data.actionsDone.join('; ')}`);
  lines.push('');

  lines.push(`| Metric | Value | Rating |${budgets ? ' Budget |' : ''}`, `| --- | --- | --- |${budgets ? ' --- |' : ''}`);
  for (const row of rows) {
    if (row.value === undefined) {
      if (row.spec.id === 'inp') continue; // only measured when actions ran
      lines.push(`| ${row.spec.label} | n/a | — |${budgets ? ' — |' : ''}`);
      continue;
    }
    let value = formatMetric(row.spec, row.value);
    if (row.spec.id === 'lcp' && options.spread) value += ` (${formatMs(options.spread.lcp[0])}–${formatMs(options.spread.lcp[1])})`;
    const budget = row.budget === undefined ? '—' : `${row.overBudget ? '❌' : '✅'} ≤ ${formatMetric(row.spec, row.budget)}`;
    lines.push(`| ${row.spec.label} | ${value} | ${ICON[row.rating!]} |${budgets ? ` ${budget} |` : ''}`);
  }
  lines.push('');

  const findings = perfFindings(data);
  if (findings.length > 0) {
    lines.push('### What to fix', '');
    for (const finding of findings) lines.push(`- ${finding}`);
    lines.push('');
  }

  lines.push('### Network', '');
  const transferBudget = budgets?.transferKb !== undefined ? ` (budget ${budgets.transferKb} kB ${scan.transferBytes / 1_000 > budgets.transferKb ? '❌' : '✅'})` : '';
  const requestBudget = budgets?.requests !== undefined ? ` (budget ${budgets.requests} ${scan.requests > budgets.requests ? '❌' : '✅'})` : '';
  lines.push(
    `**Transfer:** ${formatBytes(scan.transferBytes)}${transferBudget} in ${scan.requests} requests${requestBudget}` +
      (scan.thirdPartyOrigins > 0 ? ` · third-party: ${formatBytes(scan.thirdPartyBytes)} from ${scan.thirdPartyOrigins} origin(s)` : '') +
      ` · DOM: ${scan.domNodes} nodes${scan.jsHeapBytes ? ` · JS heap: ${formatBytes(scan.jsHeapBytes)}` : ''}`,
  );
  if (scan.byType.length > 0) {
    lines.push(`**By type:** ${scan.byType.slice(0, 6).map((t) => `${t.type} ${formatBytes(t.transferBytes)} (${t.requests})`).join(' · ')}`);
  }
  const largest = scan.largest.filter((r) => r.transferBytes > 0);
  if (largest.length > 0) {
    lines.push('', '**Heaviest requests:**');
    for (const r of largest) lines.push(`- ${formatBytes(r.transferBytes)} · ${r.type} · \`${r.url}\`${r.durationMs ? ` · ${formatMs(r.durationMs)}` : ''}`);
  }
  if (scan.renderBlocking.length > 0) {
    lines.push('', '**Render-blocking:**');
    for (const r of scan.renderBlocking) lines.push(`- ${r.type} \`${r.url}\`${r.durationMs ? ` · ${formatMs(r.durationMs)}` : ''}`);
  }
  if (options.routeLines && options.routeLines.length > 0) lines.push('', '**Network mocks:**', ...options.routeLines);
  lines.push('');

  lines.push(
    'Lab numbers from one headless Chromium; field data (CrUX, RUM) can differ. INP is measured only when `actions` interact with the page.',
    '',
    '**Keep it fast:** add a budget check to the spec that reaches this page:',
    '',
    budgetCheck(data.finalUrl ?? url, budgets),
  );
  return lines.join('\n').trimEnd();
}

/* ------------------------------------------------------------------ */
/* Tool                                                                */
/* ------------------------------------------------------------------ */

export const auditPerformanceTool = {
  name: 'audit-performance',
  description:
    "Measure a page's lab Web Vitals (LCP, CLS, TBT, FCP, TTFB, and INP when actions interact) in headless Chromium, optionally as a throttled phone and as the median of several runs. Rates them against Google thresholds or your budgets, names the LCP element and shifting elements as verified locators, lists heavy and render-blocking requests, and returns a budget check for the spec. Accepts storageState/headers/actions/routes.",
  inputSchema: auditPerformanceSchema,
  handler: async (args: AuditPerformanceInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('audit-performance', async () => {
      const url = assertHttpUrl(args.url);
      await assertUrlAllowed(url);
      if (args.browser && args.browser !== 'chromium') {
        throw new PlaywrightMcpError('audit-performance measures in Chromium only', 'INVALID_PATH', {
          hint: 'Web Vitals, byte counts and throttling come from the Chrome DevTools Protocol. Leave browser unset.',
        });
      }
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      const state = await resolvePageState(args, root, url, ctx);
      const timeoutMs = args.timeoutMs ?? 60_000;
      const mobile = args.throttle === 'mobile';
      const cpuThrottle = args.cpuSlowdown ?? (mobile ? MOBILE_PROFILE.cpuThrottle : 1);
      const runs = args.runs ?? 1;
      const profile = [
        mobile ? 'mobile, slow 4G' : 'desktop, unthrottled network',
        cpuThrottle > 1 ? `${cpuThrottle}x CPU slowdown` : undefined,
      ]
        .filter(Boolean)
        .join(', ');

      const results: BrowserScriptData[] = [];
      for (let run = 1; run <= runs; run += 1) {
        ctx.progress?.(run - 1, runs, `Loading ${url} (run ${run} of ${runs})`);
        const outcome = await runBrowserScript(
          {
            ...state,
            viewport: state.viewport ?? (mobile ? MOBILE_PROFILE.viewport : undefined),
            mode: 'perf',
            projectRoot: root,
            url,
            waitFor: args.waitFor,
            waitUntil: args.waitUntil ?? 'load',
            settleMs: args.settleMs ?? 1_500,
            mobile,
            cpuThrottle,
            network: mobile ? MOBILE_PROFILE.network : undefined,
            gotoTimeout: Math.max(5_000, timeoutMs - 10_000),
            waitTimeout: Math.min(10_000, Math.max(3_000, timeoutMs - 10_000)),
            startedAt: Date.now(),
          },
          { timeoutMs, signal: ctx.signal },
        );
        if (!outcome.ok || !outcome.data?.perf) {
          const done = outcome.actionsDone?.length ? `\n\nSteps completed before the failure: ${outcome.actionsDone.join('; ')}` : '';
          return toolError(
            outcome.kind ?? 'UNKNOWN',
            `Could not measure ${url}${runs > 1 ? ` (run ${run} of ${runs})` : ''}: ${outcome.error ?? 'no performance data'}${done}`,
            outcome.hint,
            outcome.stderrTail,
          );
        }
        results.push(outcome.data);
      }
      ctx.progress?.(runs, runs, 'Done');

      const { data, spread } = mergeRuns(results);
      let text = renderPerformance(url, data, {
        budgets: args.budgets,
        profile,
        runs,
        spread,
        stateLine: describePageState(state, root),
        routeLines: describeRouteHits(state, data.routeHits),
      });
      const login = loginHint(data.finalUrl, state);
      if (login) text += `\n\n> 🔒 ${login}`;
      const rows = metricRows(data.perf!, args.budgets);
      return toolText(text, {
        ok: !rows.some((row) => row.overBudget || row.rating === 'poor'),
        url,
        metrics: rows.map((row) => ({
          id: row.spec.id,
          ...(row.value !== undefined ? { value: row.value } : {}),
          unit: row.spec.unit,
          ...(row.rating ? { rating: row.rating } : {}),
          ...(row.budget !== undefined ? { budget: row.budget } : {}),
          overBudget: row.overBudget,
        })),
      });
    }),
};
