/**
 * Tool 12 — audit-accessibility: run axe-core (the engine behind Lighthouse
 * and @axe-core/playwright) on a live page and return the WCAG violations,
 * worst first, each with the offending elements as verified Playwright
 * locators and a ready-made regression test.
 *
 * It takes the same page state as inspect-page (storageState, headers,
 * actions), so pages behind a login, open modals and later steps of a flow
 * can be audited, which is where most real accessibility bugs sit.
 */

import { createRequire } from 'node:module';
import { z } from 'zod';
import type { ToolContext, ToolResponse } from '../types/index.js';
import {
  assertHttpUrl,
  bestLocator,
  clipLines,
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
  type AccessibilityViolation,
  type BrowserScriptData,
} from './shared.js';
import { assertUrlAllowed } from '../utils/url-policy.js';

/** WCAG 2.2 level A and AA, the usual legal and contractual bar. */
export const DEFAULT_AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor'] as const;

const auditAccessibilityInput = z.object({
  url: z.string().describe('Full URL of the page to audit (http/https)'),
  projectRoot: z.string().optional().describe('Project whose Playwright launches the browser (default: server root)'),
  selector: z.string().optional().describe('CSS selector: audit only this part of the page'),
  standard: z
    .enum(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice', 'all'])
    .optional()
    .describe("Rule set: WCAG level (default wcag22aa, i.e. 2.0–2.2 A+AA), 'best-practice' adds axe's extra rules, 'all' runs everything"),
  minImpact: z
    .enum(IMPACT_ORDER)
    .optional()
    .describe('Hide violations below this impact (default: minor, show all)'),
  waitFor: z.string().optional().describe('Wait for this selector first'),
  ...pageStateShape,
  waitUntil: z
    .enum(['load', 'domcontentloaded', 'networkidle'])
    .optional()
    .describe('Navigation wait condition (default load)'),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional().describe('Overall audit limit in ms (default 60000)'),
});

export type AuditAccessibilityInput = z.infer<typeof auditAccessibilityInput>;
export const auditAccessibilitySchema = auditAccessibilityInput;

/** axe tags for a standard; undefined runs every rule. */
export function axeTagsFor(standard: AuditAccessibilityInput['standard']): string[] | undefined {
  switch (standard ?? 'wcag22aa') {
    case 'wcag2a':
      return ['wcag2a'];
    case 'wcag2aa':
      return ['wcag2a', 'wcag2aa'];
    case 'wcag21aa':
      return ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
    case 'wcag22aa':
      return [...DEFAULT_AXE_TAGS];
    case 'best-practice':
      return [...DEFAULT_AXE_TAGS, 'best-practice'];
    default:
      return undefined;
  }
}

/** axe tags like `wcag143` → "WCAG 1.4.3". */
export function wcagCriteria(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    const m = /^wcag(\d)(\d)(\d{1,2})$/.exec(tag);
    if (m) out.push(`${m[1]}.${m[2]}.${m[3]}`);
  }
  return out;
}

export function axeSourcePath(): string {
  return createRequire(import.meta.url).resolve('axe-core/axe.min.js');
}

function impactRank(impact: string): number {
  const i = (IMPACT_ORDER as readonly string[]).indexOf(impact);
  return i === -1 ? IMPACT_ORDER.length : i;
}

/** First line of axe's failure summary that says what to change. */
function fixLine(summary: string): string {
  const lines = summary.split('\n').map((l) => l.trim()).filter(Boolean);
  const body = lines.filter((l) => !/^Fix (any|all) of the following:?$/i.test(l));
  return clipLines(body[0] ?? lines[0] ?? '', 1, 200);
}

export function renderAudit(
  url: string,
  data: BrowserScriptData,
  options: { minImpact?: (typeof IMPACT_ORDER)[number]; tags?: string[]; stateLine?: string; selector?: string; routeLines?: string[] },
): string {
  const scan = data.a11y!;
  const floor = impactRank(options.minImpact ?? 'minor');
  const all = [...scan.violations].sort((a, b) => impactRank(a.impact) - impactRank(b.impact) || b.nodeCount - a.nodeCount);
  const shown = all.filter((v) => impactRank(v.impact) <= floor);
  const hidden = all.length - shown.length;
  const standard = options.tags ? options.tags.join(', ') : 'all axe rules';
  const lines: string[] = [];

  if (scan.scopeMissing) {
    return [`## ❓ Nothing to audit`, '', `\`${options.selector}\` matched no element on ${url}. Run **inspect-page** to find the right container.`].join('\n');
  }

  const counts = IMPACT_ORDER.map((impact) => [impact, shown.filter((v) => v.impact === impact).length] as const).filter(([, n]) => n > 0);
  if (shown.length === 0) {
    lines.push(`## ✅ No accessibility violations`, '');
  } else {
    lines.push(
      `## ♿ ${shown.length} accessibility violation${shown.length === 1 ? '' : 's'} (${counts.map(([i, n]) => `${n} ${i}`).join(', ')})`,
      '',
    );
  }
  lines.push(`**URL:** ${url}${options.selector ? `  |  **Scope:** \`${options.selector}\`` : ''}  |  **Rules:** ${standard}`);
  if (options.stateLine) lines.push(`**Page state:** ${options.stateLine}`);
  if (options.routeLines?.length) lines.push('**Network mocks:**', ...options.routeLines);
  lines.push(`**Checked:** ${scan.passes} rules passed · ${scan.incomplete} need manual review${hidden ? ` · ${hidden} below ${options.minImpact} hidden` : ''}`, '');

  shown.forEach((v: AccessibilityViolation, i) => {
    const criteria = wcagCriteria(v.tags);
    lines.push(`### ${i + 1}. ${v.impact} · \`${v.id}\`: ${v.help}${criteria.length ? ` (WCAG ${criteria.join(', ')})` : ''}`);
    lines.push(`${v.nodeCount} element${v.nodeCount === 1 ? '' : 's'} · ${v.helpUrl}`);
    for (const node of v.nodes) {
      const element = node.element >= 0 ? data.elements[node.element] : undefined;
      const locator = element ? bestLocator(element) : undefined;
      lines.push(`- \`${locator ?? node.target}\`${locator ? '' : ' (CSS)'}: ${fixLine(node.summary)}`);
    }
    if (v.nodeCount > v.nodes.length) lines.push(`- …and ${v.nodeCount - v.nodes.length} more`);
    lines.push('');
  });

  if (shown.length > 0) {
    const tagList = (options.tags ?? [...DEFAULT_AXE_TAGS]).map((t) => `'${t}'`).join(', ');
    lines.push(
      '**Keep it fixed:** add this check to the spec that reaches this page (`npm i -D @axe-core/playwright`):',
      '',
      '```ts',
      "import AxeBuilder from '@axe-core/playwright';",
      '',
      `const { violations } = await new AxeBuilder({ page })${options.selector ? `.include(${JSON.stringify(options.selector)})` : ''}.withTags([${tagList}]).analyze();`,
      'expect(violations.map((v) => v.id)).toEqual([]);',
      '```',
    );
  }
  return lines.join('\n').trimEnd();
}

export const auditAccessibilityTool = {
  name: 'audit-accessibility',
  description:
    "Run axe-core on a live page (WCAG 2.2 AA by default) and return violations worst first, each with the offending elements as verified Playwright locators, the fix, and a regression check to paste into a spec. Accepts storageState/headers/actions to audit pages behind a login or after a step.",
  inputSchema: auditAccessibilitySchema,
  handler: async (args: AuditAccessibilityInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('audit-accessibility', async () => {
      const url = assertHttpUrl(args.url);
      await assertUrlAllowed(url);
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      const state = await resolvePageState(args, root, url, ctx);
      const timeoutMs = args.timeoutMs ?? 60_000;
      const tags = axeTagsFor(args.standard);

      const outcome = await runBrowserScript(
        {
          ...state,
          mode: 'a11y',
          projectRoot: root,
          url,
          selector: args.selector,
          waitFor: args.waitFor,
          waitUntil: args.waitUntil ?? 'load',
          axeSourcePath: axeSourcePath(),
          axeTags: tags,
          maxNodes: 3,
          gotoTimeout: Math.max(5_000, timeoutMs - 10_000),
          waitTimeout: Math.min(10_000, Math.max(3_000, timeoutMs - 10_000)),
          startedAt: Date.now(),
        },
        { timeoutMs, signal: ctx.signal },
      );

      if (!outcome.ok || !outcome.data?.a11y) {
        const done = outcome.actionsDone?.length ? `\n\nSteps completed before the failure: ${outcome.actionsDone.join('; ')}` : '';
        return toolError(
          outcome.kind ?? 'UNKNOWN',
          `Could not audit ${url}: ${outcome.error ?? 'no result from axe-core'}${done}`,
          outcome.hint,
          outcome.stderrTail,
        );
      }

      let text = renderAudit(url, outcome.data, {
        minImpact: args.minImpact,
        tags,
        stateLine: describePageState(state, root),
        routeLines: describeRouteHits(state, outcome.data.routeHits),
        selector: args.selector,
      });
      const login = loginHint(outcome.data.finalUrl, state);
      if (login) text += `\n\n> 🔒 ${login}`;
      return toolText(text);
    }),
};
