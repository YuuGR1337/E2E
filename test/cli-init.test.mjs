import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyInit, bundledSkillDir, detectClients, parseInitArgs, planInit } from '../dist/cli/init.js';

function tempProject() {
  return mkdtempSync(path.join(os.tmpdir(), 'pw-init-'));
}

test('parseInitArgs reads clients, flags and rejects unknown clients', () => {
  const o = parseInitArgs(['--client', 'cursor, vscode', '--tools', 'core', '--no-skill', '--dry-run'], '/p');
  assert.deepEqual(o.clients, ['cursor', 'vscode']);
  assert.equal(o.tools, 'core');
  assert.equal(o.skill, false);
  assert.equal(o.dryRun, true);
  assert.equal(o.projectRoot, path.resolve('/p'));
  assert.equal(parseInitArgs(['--client', 'all']).clients.length, 6);
  assert.deepEqual(parseInitArgs(['--client', 'gemini', '--client', 'codex']).clients, ['gemini', 'codex']);
  assert.equal(parseInitArgs([]).clients, undefined);
  assert.throws(() => parseInitArgs(['--client', 'emacs']), /--client/);
  assert.throws(() => parseInitArgs(['--bogus']), /Unknown option/);
});

test('detectClients finds client folders; planInit falls back to claude, cursor, vscode', () => {
  const root = tempProject();
  try {
    assert.deepEqual(detectClients(root), []);
    assert.deepEqual(planInit({ projectRoot: root, skill: false, dryRun: true }).clients, ['claude', 'cursor', 'vscode']);
    mkdirSync(path.join(root, '.cursor'));
    mkdirSync(path.join(root, '.gemini'));
    assert.deepEqual(detectClients(root), ['cursor', 'gemini']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init merges into existing configs, keeps other servers, and is idempotent', () => {
  const root = tempProject();
  try {
    mkdirSync(path.join(root, '.vscode'));
    writeFileSync(
      path.join(root, '.vscode', 'mcp.json'),
      JSON.stringify({ servers: { other: { command: 'x' } }, inputs: [] }),
    );
    mkdirSync(path.join(root, '.codex'));
    writeFileSync(path.join(root, '.codex', 'config.toml'), 'model = "o4"\n');
    const options = { projectRoot: root, clients: ['claude', 'vscode', 'codex', 'gemini'], tools: 'core', skill: true, dryRun: false };
    const first = planInit(options, root);
    assert.deepEqual(
      first.changes.map((c) => c.action),
      ['create', 'update', 'update', 'create', 'create', 'create'],
    );
    applyInit(first.changes);

    const vscode = JSON.parse(readFileSync(path.join(root, '.vscode', 'mcp.json'), 'utf8'));
    assert.deepEqual(vscode.servers.other, { command: 'x' });
    assert.deepEqual(vscode.inputs, []);
    assert.deepEqual(vscode.servers['playwright-e2e'], {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'playwright-e2e-mcp', '--tools=core'],
    });
    const claude = JSON.parse(readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    assert.equal(claude.mcpServers['playwright-e2e'].command, 'npx');
    const gemini = JSON.parse(readFileSync(path.join(root, '.gemini', 'settings.json'), 'utf8'));
    assert.ok(gemini.mcpServers['playwright-e2e']);
    const toml = readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8');
    assert.match(toml, /^model = "o4"\n\n\[mcp_servers\.playwright-e2e\]\ncommand = "npx"\nargs = \["-y", "playwright-e2e-mcp", "--tools=core"\]\n$/);
    for (const dir of ['.agents/skills/playwright-e2e-mcp', '.claude/skills/playwright-e2e-mcp']) {
      assert.ok(existsSync(path.join(root, dir, 'SKILL.md')), dir);
      assert.ok(existsSync(path.join(root, dir, 'references', 'tools.md')), dir);
    }

    const second = planInit(options, root);
    assert.deepEqual(
      second.changes.filter((c) => c.client !== 'skill').map((c) => c.action),
      ['unchanged', 'unchanged', 'unchanged', 'unchanged'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init leaves a config that is not valid JSON untouched and reports it', () => {
  const root = tempProject();
  try {
    mkdirSync(path.join(root, '.cursor'));
    const file = path.join(root, '.cursor', 'mcp.json');
    writeFileSync(file, '{ "mcpServers": { // comment\n');
    const { changes } = planInit({ projectRoot: root, clients: ['cursor'], skill: false, dryRun: false }, root);
    assert.equal(changes[0].action, 'error');
    applyInit(changes);
    assert.equal(readFileSync(file, 'utf8'), '{ "mcpServers": { // comment\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('windsurf writes the user-level config under the given home', () => {
  const home = tempProject();
  try {
    const { changes } = planInit({ projectRoot: home, clients: ['windsurf'], skill: false, dryRun: false }, home);
    assert.equal(changes[0].file, path.join(home, '.codeium', 'windsurf', 'mcp_config.json'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the bundled skill folder exists and the package ships it', () => {
  assert.ok(existsSync(path.join(bundledSkillDir(), 'SKILL.md')));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.files.includes('skill/playwright-e2e-mcp'));
});

test('plugin, marketplace and Gemini manifests agree with package.json', () => {
  const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
  const pkg = read('package.json');
  const plugin = read('.claude-plugin/plugin.json');
  const gemini = read('gemini-extension.json');
  const market = read('.claude-plugin/marketplace.json');
  assert.equal(plugin.version, pkg.version);
  assert.equal(gemini.version, pkg.version);
  assert.deepEqual(plugin.mcpServers['playwright-e2e'].args, ['-y', 'playwright-e2e-mcp']);
  assert.deepEqual(gemini.mcpServers['playwright-e2e'].args, ['-y', 'playwright-e2e-mcp']);
  assert.equal(market.plugins[0].name, plugin.name);
  for (const dir of plugin.skills) assert.ok(existsSync(new URL(`../${dir}/SKILL.md`, import.meta.url)), dir);
  assert.ok(existsSync(new URL(`../${gemini.contextFileName}`, import.meta.url)));
});

test('the hosted bridge explains it cannot run tests instead of suggesting an install', async () => {
  const { toolError } = await import('../dist/tools/shared.js');
  const { missingPlaywrightMessage } = await import('../dist/utils/project-detector.js');
  const saved = process.env.VERCEL;
  try {
    delete process.env.VERCEL;
    assert.match(toolError('NO_PLAYWRIGHT', 'Playwright is not installed in /p', 'Run: npm install').content[0].text, /npm install/);
    process.env.VERCEL = '1';
    const text = toolError('NO_PLAYWRIGHT', 'Playwright is not installed in /var/task', 'Run: npm install').content[0].text;
    assert.match(text, /hosted endpoint has no copy of your project/);
    assert.match(text, /page tools/);
    assert.match(text, /playwright-e2e-mcp init/);
    assert.doesNotMatch(text, /\/var\/task/);
    assert.match(missingPlaywrightMessage({ packageManager: 'npm' }).hint, /playwright-e2e-mcp init/);
  } finally {
    if (saved === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = saved;
  }
});
