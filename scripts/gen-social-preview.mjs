// Generates docs/social-preview.png (1280×640), the card GitHub, X, LinkedIn,
// Slack and Hacker News readers' link previews show for the repo. GitHub has
// no API for it: upload the PNG under Settings → General → Social preview.
//
// Re-run with: node scripts/gen-social-preview.mjs
// Requires devDependencies installed (uses @playwright/test's Chromium).

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const logo = readFileSync(join(root, 'docs', 'logo.svg'), 'utf8');

const html = `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; }
  .card { width: 1280px; height: 640px; box-sizing: border-box; padding: 72px 88px; background: #0d1117; color: #e6edf3;
          font-family: system-ui, "Segoe UI", "DejaVu Sans", sans-serif; display: flex; flex-direction: column; justify-content: space-between; }
  .top { display: flex; align-items: center; gap: 28px; }
  .top svg { width: 120px; height: 120px; }
  .name { font: 700 58px/1.1 ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace; }
  .tag { font-size: 44px; font-weight: 700; line-height: 1.2; max-width: 1050px; }
  .tag em { font-style: normal; color: #7ee787; }
  .sub { font-size: 27px; color: #8b949e; margin-top: 18px; }
  .foot { display: flex; justify-content: space-between; font: 24px ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace; color: #8b949e; }
  .foot b { color: #7ee787; font-weight: 600; }
</style>
<div class="card">
  <div class="top">${logo}<div class="name">playwright-e2e-mcp</div></div>
  <div>
    <div class="tag">Your Playwright test fails. Your AI finds out why, fixes it, and <em>proves the fix works</em>.</div>
    <div class="sub">MCP server + agent skill · Claude, Cursor, VS Code, Gemini, Codex · MIT</div>
  </div>
  <div class="foot"><b>npx -y playwright-e2e-mcp</b><span>github.com/xsignon-secure/E2E</span></div>
</div>`;

const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
  await page.setContent(html);
  const out = join(root, 'docs', 'social-preview.png');
  await page.screenshot({ path: out });
  process.stdout.write(`Wrote ${out}\n`);
} finally {
  await browser.close();
}
