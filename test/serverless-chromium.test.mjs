import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverlessChromiumEnabled } from '../dist/utils/serverless-chromium.js';
import { inspectPageTool } from '../dist/tools/inspect-page.js';
import { createToolStore } from '../dist/tools/shared.js';
import { logger } from '../dist/utils/logger.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('serverless Chromium is on for Vercel and switchable by env', () => {
  assert.equal(withEnv({ VERCEL: undefined, PW_MCP_SERVERLESS_CHROMIUM: undefined }, serverlessChromiumEnabled), false);
  assert.equal(withEnv({ VERCEL: '1', PW_MCP_SERVERLESS_CHROMIUM: undefined }, serverlessChromiumEnabled), true);
  assert.equal(withEnv({ VERCEL: '1', PW_MCP_SERVERLESS_CHROMIUM: '0' }, serverlessChromiumEnabled), false);
  assert.equal(withEnv({ VERCEL: undefined, PW_MCP_SERVERLESS_CHROMIUM: '1' }, serverlessChromiumEnabled), true);
});

// The bundled binary is Linux x64 and the package needs Node 22+.
const canLaunch = process.platform === 'linux' && process.arch === 'x64' && Number(process.versions.node.split('.')[0]) >= 22;

test('inspect-page runs on the serverless Chromium with only playwright-core', { skip: !canLaunch && 'needs Linux x64 and Node 22+' }, async () => {
  // A project like the Vercel function: playwright-core, no @playwright/test.
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pw-serverless-')));
  mkdirSync(path.join(root, 'node_modules'));
  symlinkSync(path.join(repo, 'node_modules', 'playwright-core'), path.join(root, 'node_modules', 'playwright-core'), 'junction');

  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<title>Shop</title><h1>Cart</h1><button>Pay now</button>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  process.env.PW_MCP_SERVERLESS_CHROMIUM = '1';
  try {
    const ctx = { logger: logger.child({ tool: 'test' }), store: createToolStore(), projectRoot: root };
    const result = await inspectPageTool.handler({ url, view: 'aria', timeoutMs: 60_000 }, ctx);
    const text = result.content[0].text;
    assert.equal(result.isError, undefined, text);
    assert.match(text, /button "Pay now"/);

    const firefox = await inspectPageTool.handler({ url, browser: 'firefox' }, ctx);
    assert.equal(firefox.isError, true);
    assert.match(firefox.content[0].text, /not available on the hosted endpoint/);
  } finally {
    delete process.env.PW_MCP_SERVERLESS_CHROMIUM;
    server.close();
  }
});
