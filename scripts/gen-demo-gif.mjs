// Generates the README demo GIF (docs/demo.gif): an agent fixing a broken
// Playwright locator with run-test → suggest-fix → suggest-fix apply.
//
// Every line shown comes from a real run: the script serves the token
// benchmark's storefront (bench/app.mjs), starts `node dist/index.js` over
// stdio against bench/project, makes the three tool calls, and pulls the
// lines it shows out of their actual responses. Only the agent's prompt and
// the closing caption are written here.
//
// Re-run with: npm run build && node scripts/gen-demo-gif.mjs
// Requires devDependencies installed (uses @playwright/test's Chromium) and
// ffmpeg on PATH (or FFMPEG=/path/to/ffmpeg).

import { chromium } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startApp } from '../bench/app.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const project = join(root, 'bench', 'project');
const spec = join(project, 'tests', 'checkout.spec.ts');
const out = join(root, 'docs', 'demo.gif');

/** Minimal MCP stdio client: one JSON-RPC message per line. */
function startServer(env) {
  const child = spawn(process.execPath, [join(root, 'dist', 'index.js')], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const pending = new Map();
  let id = 0;
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      try {
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      } catch {
        // not a JSON-RPC line
      }
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
  return {
    async init() {
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'demo-gif', version: '1' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    async call(name, args) {
      const result = await request('tools/call', { name, arguments: args });
      return (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    },
    close: () => child.kill(),
  };
}

async function capture() {
  const app = await startApp();
  copyFileSync(join(project, 'tests', 'checkout.spec.ts.txt'), spec);
  const server = startServer({ BENCH_URL: app.origin, PW_MCP_PROJECT_ROOT: project, PW_MCP_HISTORY: '0', LOG_LEVEL: 'silent' });
  try {
    await server.init();
    const run = await server.call('run-test', { testFiles: ['tests/checkout.spec.ts'], retryOnFailure: false });
    const fix = await server.call('suggest-fix', {});
    const applied = await server.call('suggest-fix', { apply: true });
    return { run, fix, applied };
  } finally {
    server.close();
    app.close();
    rmSync(spec, { force: true });
    rmSync(join(project, 'test-results'), { recursive: true, force: true });
  }
}

/** The first line of `text` matching `re`; throws so a changed output can't silently produce a wrong GIF. */
function pick(text, re, what) {
  const line = text.split('\n').find((l) => re.test(l));
  if (!line) throw new Error(`demo: no ${what} line in tool output:\n${text}`);
  return line.trim();
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');

function scenes({ run, fix, applied }) {
  const stats = run.split('\n').find((l) => /^\|\s*\d+\s*\|/.test(l));
  if (!stats) throw new Error(`demo: no stats row in run-test output:\n${run}`);
  const [passed, failed] = stats.split('|').map((c) => c.trim()).filter(Boolean);
  const runBlock = [
    `<div class="tool">● run-test <span class="arg">tests/checkout.spec.ts</span></div>`,
    `<div class="res"><span class="red">${md(pick(run, /^## Playwright run/, 'run heading').replace(/^## /, ''))}</span> · ${passed} passed · ${failed} failed</div>`,
    `<div class="res dim">${md(pick(run, /^TimeoutError|^Error/, 'error'))}</div>`,
    `<div class="res dim">${md(pick(run, /waiting for/, 'call log').replace(/^- /, ''))}</div>`,
  ];
  const fixBlock = [
    `<div class="tool">● suggest-fix</div>`,
    `<div class="res">${md(pick(fix, /^### Proposed locator fix/, 'fix heading').replace(/^### /, ''))}</div>`,
    `<div class="res diff del">${esc(pick(fix, /^-\s+await/, 'removed line').replace(/^-\s+/, '- '))}</div>`,
    `<div class="res diff add">${esc(pick(fix, /^\+\s+await/, 'added line').replace(/^\+\s+/, '+ '))}</div>`,
  ];
  const applyBlock = [
    `<div class="tool">● suggest-fix <span class="arg">apply: true</span></div>`,
    `<div class="res">${md(pick(applied, /^\*\*Applied\*\*/, 'applied'))}</div>`,
    `<div class="res green">${md(pick(applied, /Verified/, 'verified').replace(/^### /, ''))}</div>`,
  ];
  const prompt = 'The checkout test is failing. Fix it.';
  const frames = [];
  // Type the prompt, then reveal each tool call's lines one at a time.
  for (const n of [0, 9, 18, 27, prompt.length]) frames.push({ prompt: prompt.slice(0, n), lines: [], ms: n === prompt.length ? 700 : 140 });
  const shown = [];
  for (const block of [runBlock, fixBlock, applyBlock]) {
    for (const [i, line] of block.entries()) {
      shown.push(line);
      frames.push({ prompt, lines: [...shown], ms: i === block.length - 1 ? 1600 : 450 });
    }
    shown.push('<div class="gap"></div>');
  }
  frames.at(-1).ms = 2600;
  frames.push({ prompt, lines: [...shown], caption: true, ms: 3200 });
  return frames;
}

const page = ({ prompt, lines, caption }) => `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; background: #0d1117; }
  .card { width: 860px; height: 520px; box-sizing: border-box; padding: 22px 26px; position: relative;
          font: 15px/1.55 ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace; color: #c9d1d9; }
  .bar { display: flex; gap: 7px; margin-bottom: 16px; }
  .bar i { width: 11px; height: 11px; border-radius: 50%; background: #30363d; }
  .bar span { margin-left: 10px; font-size: 12px; color: #6e7681; }
  .prompt { color: #e6edf3; margin-bottom: 14px; }
  .prompt b { color: #7ee787; }
  .cursor { display: inline-block; width: 8px; height: 17px; background: #7ee787; vertical-align: -3px; margin-left: 2px; }
  .tool { color: #d2a8ff; font-weight: 700; }
  .arg { color: #8b949e; font-weight: 400; }
  .res { padding-left: 18px; white-space: pre-wrap; }
  .dim { color: #8b949e; }
  .red { color: #ff7b72; font-weight: 700; }
  .green { color: #7ee787; font-weight: 700; }
  .diff { font-size: 13.5px; }
  .del { color: #ffa198; } .add { color: #7ee787; }
  .gap { height: 10px; }
  code { color: #a5d6ff; }
  b { color: #e6edf3; }
  .caption { position: absolute; inset: auto 0 0 0; padding: 16px 26px; background: #161b22; border-top: 1px solid #30363d;
             display: flex; justify-content: space-between; align-items: center; font-size: 14px; }
  .caption .name { color: #e6edf3; font-weight: 700; }
  .caption .cmd { color: #7ee787; }
</style>
<div class="card">
  <div class="bar"><i></i><i></i><i></i><span>AI agent + playwright-e2e-mcp</span></div>
  <div class="prompt"><b>&gt;</b> ${esc(prompt)}${lines.length ? '' : '<span class="cursor"></span>'}</div>
  ${lines.join('\n  ')}
  ${caption ? '<div class="caption"><span class="name">playwright-e2e-mcp · fixes are re-run before they are kept</span><span class="cmd">npx -y playwright-e2e-mcp</span></div>' : ''}
</div>`;

const frames = scenes(await capture());
const dir = mkdtempSync(join(tmpdir(), 'pw-mcp-gif-'));
const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
try {
  const p = await browser.newPage({ viewport: { width: 860, height: 520 } });
  const list = [];
  for (const [i, frame] of frames.entries()) {
    const html = join(dir, 'frame.html');
    writeFileSync(html, page(frame));
    await p.goto(pathToFileURL(html).href);
    const png = join(dir, `f${String(i).padStart(3, '0')}.png`);
    await p.screenshot({ path: png });
    list.push(`file '${png}'`, `duration ${(frame.ms / 1000).toFixed(2)}`);
  }
  // The concat demuxer ignores the last duration unless the last file is repeated.
  list.push(list.at(-2));
  writeFileSync(join(dir, 'list.txt'), `${list.join('\n')}\n`);
  const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
  execFileSync(ffmpeg, [
    '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'),
    '-vf', 'fps=10,split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none',
    '-loop', '0', out,
  ]);
  process.stdout.write(`Wrote ${out} (${frames.length} frames)\n`);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
