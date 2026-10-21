import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { axeSourcePath, axeTagsFor, renderAudit, wcagCriteria } from '../dist/tools/audit-accessibility.js';

test('axeTagsFor maps standards to axe tags; all runs every rule', () => {
  assert.deepEqual(axeTagsFor(undefined), ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  assert.deepEqual(axeTagsFor('wcag2a'), ['wcag2a']);
  assert.ok(axeTagsFor('best-practice').includes('best-practice'));
  assert.equal(axeTagsFor('all'), undefined);
});

test('wcagCriteria turns axe tags into success criteria', () => {
  assert.deepEqual(wcagCriteria(['cat.text-alternatives', 'wcag2a', 'wcag111', 'wcag1410', 'section508']), ['1.1.1', '1.4.10']);
});

test('the bundled axe-core is resolvable', () => {
  assert.ok(existsSync(axeSourcePath()));
});

const data = {
  matchCount: 2,
  elementCount: 1,
  elements: [{ tag: 'button', selector: '#go', visible: true, attributes: {}, locators: [[{ method: 'getByTestId', args: ['go'] }]] }],
  a11y: {
    passes: 12,
    incomplete: 1,
    violations: [
      { id: 'region', impact: 'moderate', help: 'Content should be in landmarks', helpUrl: 'https://x/region', tags: ['best-practice'], nodeCount: 1, nodes: [{ target: 'p', html: '<p>', summary: 'Fix any of the following:\n  Some page content is not contained by landmarks', element: -1 }] },
      { id: 'button-name', impact: 'critical', help: 'Buttons must have discernible text', helpUrl: 'https://x/button-name', tags: ['wcag2a', 'wcag412'], nodeCount: 4, nodes: [{ target: '#go', html: '<button id="go">', summary: 'Fix any of the following:\n  Element does not have inner text', element: 0 }] },
    ],
  },
};

test('renderAudit lists violations worst first with verified locators, WCAG ids and a regression check', () => {
  const text = renderAudit('http://app/', data, { tags: ['wcag2a'] });
  assert.match(text, /^## ♿ 2 accessibility violations \(1 critical, 1 moderate\)/);
  assert.ok(text.indexOf('`button-name`') < text.indexOf('`region`'));
  assert.ok(text.includes("- `getByTestId('go')`: Element does not have inner text"));
  assert.ok(text.includes('(WCAG 4.1.2)'));
  assert.ok(text.includes('- …and 3 more'));
  assert.ok(text.includes('- `p` (CSS): Some page content is not contained by landmarks'));
  assert.ok(text.includes(".withTags(['wcag2a']).analyze();"));
  assert.ok(text.includes('12 rules passed · 1 need manual review'));
});

test('renderAudit hides violations below minImpact and reports a clean page', () => {
  const filtered = renderAudit('http://app/', data, { minImpact: 'serious' });
  assert.match(filtered, /^## ♿ 1 accessibility violation \(1 critical\)/);
  assert.ok(filtered.includes('1 below serious hidden'));
  assert.ok(!filtered.includes('`region`'));
  const clean = renderAudit('http://app/', { ...data, a11y: { passes: 20, incomplete: 0, violations: [] } }, {});
  assert.match(clean, /^## ✅ No accessibility violations/);
  assert.ok(!clean.includes('AxeBuilder'));
  const missing = renderAudit('http://app/', { ...data, a11y: { passes: 0, incomplete: 0, violations: [], scopeMissing: true } }, { selector: '#nope' });
  assert.ok(missing.includes('`#nope` matched no element'));
});
