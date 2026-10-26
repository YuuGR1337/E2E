/**
 * `playwright-e2e-mcp init`: one command an agent (or a person) runs to wire
 * the server and the agent skill into a project, for whichever clients the
 * project uses. Config files are merged, never replaced: other servers and
 * settings stay as they are, an existing playwright-e2e entry is updated in
 * place, and a file that is not valid JSON is left untouched and reported.
 *
 * Exit codes: 0 done (or nothing to do), 1 a file could not be updated,
 * 2 bad arguments.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const SERVER_NAME = 'playwright-e2e';
export const SKILL_NAME = 'playwright-e2e-mcp';

export const CLIENTS = ['claude', 'cursor', 'vscode', 'gemini', 'codex', 'windsurf'] as const;
export type Client = (typeof CLIENTS)[number];

export const INIT_USAGE = [
  'Usage: playwright-e2e-mcp init [options]',
  '',
  'Adds the playwright-e2e MCP server and the playwright-e2e-mcp agent skill to a',
  'project. Existing config files are merged, never overwritten.',
  '',
  '  --client <list>        comma separated: claude, cursor, vscode, gemini, codex,',
  '                         windsurf, or all (default: the clients the project already',
  '                         uses, or claude,cursor,vscode when none is found)',
  '  --project-root <dir>   project directory (default: cwd)',
  '  --tools <list>         expose only these tools/profiles (e.g. core), see --help',
  '  --no-skill             do not install the agent skill',
  '  --dry-run              print what would change without writing',
  '',
  'Files (project scope): claude .mcp.json · cursor .cursor/mcp.json ·',
  'vscode .vscode/mcp.json · gemini .gemini/settings.json · codex .codex/config.toml.',
  'windsurf has no project file; it writes ~/.codeium/windsurf/mcp_config.json.',
  'Skill: .agents/skills/ (read by Codex, Gemini, Cursor and others) and',
  '.claude/skills/ when claude is selected.',
  '',
].join('\n');

export interface InitOptions {
  projectRoot: string;
  clients?: Client[];
  tools?: string;
  skill: boolean;
  dryRun: boolean;
}

export function parseInitArgs(argv: string[], cwd = process.cwd()): InitOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      client: { type: 'string', multiple: true },
      'project-root': { type: 'string' },
      tools: { type: 'string' },
      'no-skill': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
  });
  let clients: Client[] | undefined;
  if (values.client !== undefined) {
    // `--client gemini --client codex` and `--client gemini,codex` mean the same.
    const names = values.client.join(',').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (names.includes('all')) clients = [...CLIENTS];
    else {
      const unknown = names.filter((n) => !(CLIENTS as readonly string[]).includes(n));
      if (unknown.length || !names.length) {
        throw new Error(`--client must list ${CLIENTS.join(', ')} or all (got: ${unknown.join(', ') || 'nothing'})`);
      }
      clients = [...new Set(names)] as Client[];
    }
  }
  return {
    projectRoot: path.resolve(cwd, values['project-root'] ?? '.'),
    clients,
    tools: values.tools,
    skill: !values['no-skill'],
    dryRun: Boolean(values['dry-run']),
  };
}

/** Clients whose project folder or config file already exists. */
export function detectClients(root: string): Client[] {
  const has = (p: string) => existsSync(path.join(root, p));
  const found: Client[] = [];
  if (has('.mcp.json') || has('.claude') || has('CLAUDE.md')) found.push('claude');
  if (has('.cursor')) found.push('cursor');
  if (has('.vscode')) found.push('vscode');
  if (has('.gemini') || has('GEMINI.md')) found.push('gemini');
  if (has('.codex')) found.push('codex');
  return found;
}

function serverArgs(tools?: string): string[] {
  return tools ? ['-y', 'playwright-e2e-mcp', `--tools=${tools}`] : ['-y', 'playwright-e2e-mcp'];
}

export interface PlannedChange {
  client: Client | 'skill';
  file: string;
  action: 'create' | 'update' | 'unchanged' | 'error';
  content?: string;
  error?: string;
}

/** Merges our entry into a JSON config under `key`, keeping everything else. */
function planJson(file: string, key: string, entry: Record<string, unknown>, client: Client): PlannedChange {
  let data: Record<string, unknown> = {};
  let existed = false;
  if (existsSync(file)) {
    existed = true;
    const raw = readFileSync(file, 'utf8');
    if (raw.trim()) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
        data = parsed as Record<string, unknown>;
      } catch (err) {
        return { client, file, action: 'error', error: `not valid JSON (${(err as Error).message}); left unchanged` };
      }
    }
  }
  const current = data[key];
  const servers =
    current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  const before = JSON.stringify(servers[SERVER_NAME]);
  servers[SERVER_NAME] = entry;
  if (existed && before === JSON.stringify(entry)) return { client, file, action: 'unchanged' };
  return { client, file, action: existed ? 'update' : 'create', content: `${JSON.stringify({ ...data, [key]: servers }, null, 2)}\n` };
}

/** Codex reads TOML; append our table unless one is already there. */
function planCodex(file: string, args: string[]): PlannedChange {
  const table = `[mcp_servers.${SERVER_NAME}]`;
  const block = `${table}\ncommand = "npx"\nargs = [${args.map((a) => JSON.stringify(a)).join(', ')}]\n`;
  if (!existsSync(file)) return { client: 'codex', file, action: 'create', content: block };
  const raw = readFileSync(file, 'utf8');
  if (raw.includes(table)) return { client: 'codex', file, action: 'unchanged' };
  const sep = raw.length === 0 || raw.endsWith('\n\n') ? '' : raw.endsWith('\n') ? '\n' : '\n\n';
  return { client: 'codex', file, action: 'update', content: `${raw}${sep}${block}` };
}

export function planInit(options: InitOptions, home = os.homedir()): { clients: Client[]; changes: PlannedChange[] } {
  const root = options.projectRoot;
  let clients = options.clients ?? detectClients(root);
  if (!clients.length) clients = ['claude', 'cursor', 'vscode'];
  const args = serverArgs(options.tools);
  const stdio = { command: 'npx', args };
  const changes: PlannedChange[] = [];
  for (const client of clients) {
    switch (client) {
      case 'claude':
        changes.push(planJson(path.join(root, '.mcp.json'), 'mcpServers', { type: 'stdio', ...stdio }, client));
        break;
      case 'cursor':
        changes.push(planJson(path.join(root, '.cursor', 'mcp.json'), 'mcpServers', stdio, client));
        break;
      case 'vscode':
        changes.push(planJson(path.join(root, '.vscode', 'mcp.json'), 'servers', { type: 'stdio', ...stdio }, client));
        break;
      case 'gemini':
        changes.push(planJson(path.join(root, '.gemini', 'settings.json'), 'mcpServers', stdio, client));
        break;
      case 'codex':
        changes.push(planCodex(path.join(root, '.codex', 'config.toml'), args));
        break;
      case 'windsurf':
        changes.push(planJson(path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), 'mcpServers', stdio, client));
        break;
    }
  }
  if (options.skill) {
    const targets = [path.join(root, '.agents', 'skills', SKILL_NAME)];
    if (clients.includes('claude')) targets.push(path.join(root, '.claude', 'skills', SKILL_NAME));
    for (const dir of targets) {
      changes.push({ client: 'skill', file: dir, action: existsSync(path.join(dir, 'SKILL.md')) ? 'update' : 'create' });
    }
  }
  return { clients, changes };
}

/** The skill folder shipped in the npm package (dist/cli → ../../skill). */
export function bundledSkillDir(): string {
  return fileURLToPath(new URL(`../../skill/${SKILL_NAME}/`, import.meta.url));
}

export function applyInit(changes: PlannedChange[], skillSource = bundledSkillDir()): void {
  for (const change of changes) {
    if (change.action === 'error' || change.action === 'unchanged') continue;
    if (change.client === 'skill') {
      mkdirSync(change.file, { recursive: true });
      cpSync(skillSource, change.file, { recursive: true, force: true });
      continue;
    }
    mkdirSync(path.dirname(change.file), { recursive: true });
    writeFileSync(change.file, change.content ?? '');
  }
}

export function runInit(argv: string[], out: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): number {
  let options: InitOptions;
  try {
    options = parseInitArgs(argv);
  } catch (err) {
    out(`init: ${(err as Error).message}\n`);
    out(INIT_USAGE);
    return 2;
  }
  const { clients, changes } = planInit(options);
  if (options.skill && !existsSync(path.join(bundledSkillDir(), 'SKILL.md'))) {
    out('init: the skill files are missing from this install; skipping the skill.');
    for (const c of changes) if (c.client === 'skill') c.action = 'unchanged';
  }
  if (!options.dryRun) applyInit(changes);
  const rel = (p: string) => (p.startsWith(options.projectRoot) ? path.relative(options.projectRoot, p) || '.' : p);
  out(`${options.dryRun ? 'Would set up' : 'Set up'} playwright-e2e for: ${clients.join(', ')}`);
  for (const c of changes) {
    const what = c.client === 'skill' ? 'skill' : c.client;
    out(`  ${c.action.padEnd(9)} ${rel(c.file)} (${what})${c.error ? `: ${c.error}` : ''}`);
  }
  out('');
  out('Next: make sure browsers are installed (npx playwright install chromium), then');
  out('restart or reload the agent so it picks up the new server. Check the setup any');
  out('time with: npx -y playwright-e2e-mcp doctor');
  return changes.some((c) => c.action === 'error') ? 1 : 0;
}
