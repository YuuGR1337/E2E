/**
 * Pro Cloud client: shared CI run history for teams that subscribe to Pro.
 *
 * Strictly opt-in. Nothing here makes a network call unless
 * PW_MCP_PRO_KEY is set; without it the server behaves exactly as before.
 * The key is the license key from the Pro subscription; PW_MCP_PRO_URL
 * points at the Pro Cloud deployment. There is deliberately no built-in
 * default URL: the key only ever goes where the user pointed it.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { PlaywrightMcpError } from '../types/index.js';
import type { HistoryEntry } from './run-history.js';
import { parseHistory } from './run-history.js';

const PROJECT_RE = /^[A-Za-z0-9][\w./-]{0,99}$/;
const UPLOAD_BATCH = 100;

export interface ProSettings {
  key: string;
  url: string;
}

/** The Pro settings, or undefined when Pro is not configured (the normal case). */
export function proSettings(env: NodeJS.ProcessEnv = process.env): ProSettings | undefined {
  const key = env.PW_MCP_PRO_KEY?.trim();
  if (!key) return undefined;
  const url = (env.PW_MCP_PRO_URL?.trim() ?? '').replace(/\/+$/, '');
  if (!url) {
    throw new PlaywrightMcpError('PW_MCP_PRO_KEY is set but PW_MCP_PRO_URL is not', 'INVALID_INPUT', {
      hint: 'Set PW_MCP_PRO_URL to the Pro Cloud address from your welcome email, or unset PW_MCP_PRO_KEY.',
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PlaywrightMcpError(`PW_MCP_PRO_URL is not a URL: ${url}`, 'INVALID_INPUT');
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new PlaywrightMcpError('PW_MCP_PRO_URL must use https', 'INVALID_INPUT', { hint: 'The Pro key is sent with every request.' });
  }
  return { key, url };
}

function git(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 3_000, windowsHide: true }, (err, stdout) => resolve(err ? undefined : String(stdout).trim()));
  });
}

/**
 * The project name runs are filed under: PW_MCP_PRO_PROJECT, else the
 * GitHub repository (owner/name, from CI or the origin remote), else the
 * folder name. The same rule on CI and laptops, so both see one history.
 */
export async function proProjectName(root: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const candidates: Array<string | undefined> = [env.PW_MCP_PRO_PROJECT, env.GITHUB_REPOSITORY];
  const remote = await git(['remote', 'get-url', 'origin'], root);
  const match = remote ? /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote) : null;
  candidates.push(match?.[1], path.basename(root));
  for (const raw of candidates) {
    const name = raw?.trim();
    if (name && PROJECT_RE.test(name) && !name.includes('..')) return name;
  }
  return 'project';
}

async function call(settings: ProSettings, method: string, pathAndQuery: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${settings.url}/api/v1/${pathAndQuery}`, {
      method,
      headers: { authorization: `Bearer ${settings.key}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new PlaywrightMcpError(`Pro Cloud is unreachable (${settings.url}): ${(error as Error).message}`, 'UNKNOWN', {
      hint: 'Check the network and PW_MCP_PRO_URL; local history still works.',
    });
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string; hint?: string };
  if (!response.ok) {
    throw new PlaywrightMcpError(`Pro Cloud: ${data.error ?? `HTTP ${response.status}`}`, response.status === 401 ? 'INVALID_INPUT' : 'UNKNOWN', {
      hint: data.hint,
    });
  }
  return data;
}

export async function uploadRuns(settings: ProSettings, project: string, runs: HistoryEntry[]): Promise<{ stored: number; skipped: number }> {
  let stored = 0;
  let skipped = 0;
  for (let i = 0; i < runs.length; i += UPLOAD_BATCH) {
    const batch = runs.slice(i, i + UPLOAD_BATCH);
    const result = (await call(settings, 'POST', 'runs', { project, runs: batch })) as { stored?: number; skipped?: number };
    stored += result.stored ?? 0;
    skipped += result.skipped ?? 0;
  }
  return { stored, skipped };
}

export async function fetchRuns(settings: ProSettings, project: string, limit: number): Promise<HistoryEntry[]> {
  const result = (await call(settings, 'GET', `runs?project=${encodeURIComponent(project)}&limit=${limit}`)) as { runs?: unknown[] };
  // Same parser as the local file: anything malformed is dropped.
  return parseHistory((result.runs ?? []).map((run) => JSON.stringify(run)).join('\n'));
}

/** Local and cloud runs together, oldest first, without duplicates. */
export function mergeRuns(local: HistoryEntry[], cloud: HistoryEntry[], last: number): HistoryEntry[] {
  const seen = new Set<string>();
  const out: HistoryEntry[] = [];
  for (const entry of [...local, ...cloud]) {
    const key = `${entry.at}\u0000${entry.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(-last);
}
