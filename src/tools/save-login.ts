/**
 * Tool — save-login: log in once and save the session as a Playwright
 * storageState file that tests and the page tools reuse. Before logging in
 * again it checks whether the saved session still works, so expired logins
 * refresh themselves and valid ones are left alone.
 *
 * Passwords and one-time codes never pass through the chat: fill values
 * may say {{env:E2E_PASSWORD}} (read from the server's environment) and
 * {{totp}} (an authenticator code generated from a secret in an
 * environment variable at the moment it is typed).
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { PlaywrightMcpError } from '../types/index.js';
import type { ToolContext, ToolResponse } from '../types/index.js';
import { relativeToRoot, sanitizeUserPath, toNativePath, writeFileInsideRoot } from '../utils/path-utils.js';
import { parseLocator } from '../utils/locator-expr.js';
import { parseTotpSecret } from '../utils/totp.js';
import { assertUrlAllowed } from '../utils/url-policy.js';
import {
  assertHttpUrl,
  guard,
  pageActionSchema,
  resolvePageState,
  resolveProjectRoot,
  runBrowserScript,
  toolError,
  toolText,
} from './shared.js';
import type { BrowserScriptConfig, LoginScan, ResolvedPageState } from './shared.js';

const saveLoginInput = z.object({
  url: z.string().describe('Login page URL (http/https)'),
  actions: z
    .array(pageActionSchema)
    .max(20)
    .optional()
    .describe(
      "Login steps. In fill values write {{env:E2E_PASSWORD}} for a secret from the environment and {{totp}} for an authenticator code, never the secret itself. End with a 'wait' on something only signed-in users see",
    ),
  verify: z
    .object({
      url: z.string().optional().describe('Page to open to check the session, e.g. /account (default: where login ends)'),
      visible: z.string().optional().describe("Locator only a signed-in user sees, e.g. getByRole('button', { name: 'Sign out' })"),
      notUrl: z.string().optional().describe("The session is bad if the page lands on a URL containing this, e.g. '/login'"),
    })
    .optional()
    .describe('How to tell the session works; also used to decide whether a saved session is still valid'),
  name: z
    .string()
    .regex(/^[\w.-]{1,40}$/)
    .optional()
    .describe("Session name, e.g. 'admin' (default 'user'); saved to playwright/.auth/<name>.json"),
  path: z.string().optional().describe('Where to save the storageState JSON inside the project (overrides name)'),
  totpSecretEnv: z
    .string()
    .optional()
    .describe('Environment variable holding the authenticator secret (base32 or otpauth:// URI), for {{totp}}'),
  reuse: z.boolean().optional().describe('Keep a saved session that still passes verify instead of logging in again (default true)'),
  headers: z.record(z.string(), z.string()).optional().describe('Extra HTTP headers'),
  viewport: z.object({ width: z.number().int().min(200).max(4_000), height: z.number().int().min(200).max(4_000) }).optional(),
  actionTimeoutMs: z.number().int().min(1_000).max(120_000).optional().describe('How long each step waits for its element (default 10000)'),
  projectRoot: z.string().optional().describe('Project directory (default: server root)'),
  timeoutMs: z.number().int().min(5_000).max(300_000).optional().describe('Overall limit in ms (default 60000)'),
});

export type SaveLoginInput = z.infer<typeof saveLoginInput>;
export const saveLoginSchema = saveLoginInput;

const ENV_TOKEN_RE = /\{\{\s*env:([A-Za-z0-9_]+)\s*\}\}/g;
const TOTP_TOKEN_RE = /\{\{\s*totp\s*\}\}/;

/**
 * Environment variables a login may read. A page the agent visits could
 * ask it to type {{env:AWS_SECRET_ACCESS_KEY}} into a form, so only names
 * that are plainly test logins are allowed, plus any the user lists.
 */
export function loginEnvAllowed(name: string): boolean {
  if (/^(E2E|TEST|PW|PLAYWRIGHT|LOGIN)_[A-Z0-9_]+$/.test(name) && name !== 'PW_MCP_HTTP_TOKEN') return true;
  const extra = (process.env.PW_MCP_LOGIN_ENV ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return extra.includes(name);
}

/** The environment values the fill steps ask for, checked and read. */
export function resolveLoginValues(actions: SaveLoginInput['actions']): Record<string, string> {
  const names = new Set<string>();
  for (const action of actions ?? []) {
    if (action.type !== 'fill' || !action.value) continue;
    for (const match of action.value.matchAll(ENV_TOKEN_RE)) names.add(match[1]);
  }
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    if (!loginEnvAllowed(name)) {
      throw new PlaywrightMcpError(`{{env:${name}}} is not an allowed login variable`, 'INVALID_INPUT', {
        hint: 'Name login secrets E2E_*, TEST_*, PW_*, PLAYWRIGHT_* or LOGIN_* (e.g. E2E_PASSWORD), or list the name in PW_MCP_LOGIN_ENV.',
      });
    }
    const value = process.env[name];
    if (value === undefined || value === '') missing.push(name);
    else values[name] = value;
  }
  if (missing.length > 0) {
    throw new PlaywrightMcpError(`Not set in the server's environment: ${missing.join(', ')}`, 'INVALID_INPUT', {
      hint: 'Set them where the MCP server starts (the env block of your MCP client config, or the shell), then restart the server.',
    });
  }
  return values;
}

/** A literal typed into a password field: worth moving into an env variable. */
function literalPasswordStep(actions: SaveLoginInput['actions']): boolean {
  return (actions ?? []).some(
    (a) => a.type === 'fill' && /pass(word|code)?|pin\b/i.test(a.locator ?? '') && !!a.value && !a.value.includes('{{'),
  );
}

function expiryText(scan: LoginScan): string {
  if (scan.firstExpiry === null) return scan.cookies > 0 ? 'session cookies only (they end when the browser closes)' : 'no cookies';
  const seconds = scan.firstExpiry - Date.now() / 1000;
  const when = new Date(scan.firstExpiry * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  if (seconds <= 0) return `a cookie already expired (${when})`;
  const hours = seconds / 3600;
  const span = hours < 48 ? `${Math.max(1, Math.round(hours))} h` : `${Math.round(hours / 24)} days`;
  return `first cookie expires in ${span} (${when})`;
}

/** Is the session file covered by .gitignore? A rough check that catches the common miss. */
async function ignoredByGit(root: string, relative: string): Promise<boolean> {
  const text = await readFile(toNativePath(path.posix.join(root, '.gitignore')), 'utf8').catch(() => '');
  const lines = text.split(/\r?\n/).map((line) => line.trim().replace(/^\//, '').replace(/\/$/, ''));
  const parts = relative.split('/');
  for (let i = 1; i <= parts.length; i += 1) {
    const prefix = parts.slice(0, i).join('/');
    if (lines.includes(prefix) || lines.includes(`${prefix}/*`) || lines.includes(`${prefix}/**`)) return true;
  }
  return lines.some((line) => line === '*.auth.json' || line === '.auth' || (line.endsWith('.json') && relative.endsWith(line)));
}

function scanLines(scan: LoginScan): string[] {
  return [
    `**Session:** ${scan.cookies} cookie${scan.cookies === 1 ? '' : 's'}, ${scan.origins} origin${scan.origins === 1 ? '' : 's'} with local storage · ${expiryText(scan)}`,
  ];
}

export const saveLoginTool = {
  name: 'save-login',
  description:
    "Log in once and save the session as a storageState file (default playwright/.auth/<name>.json) for tests and the page tools. If a saved session still passes verify it is reused; expired ones log in again. Secrets stay out of chat: fill values use {{env:E2E_PASSWORD}} and {{totp}} (authenticator code from totpSecretEnv).",
  inputSchema: saveLoginSchema,
  handler: async (args: SaveLoginInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('save-login', async () => {
      if (ctx.restricted) {
        throw new PlaywrightMcpError('save-login is not available on this server', 'INVALID_PATH', {
          hint: 'It writes a session file into the project. Run the server locally.',
        });
      }
      const url = assertHttpUrl(args.url);
      await assertUrlAllowed(url);
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      const timeoutMs = args.timeoutMs ?? 60_000;

      const relativeTarget = args.path?.trim() || `playwright/.auth/${args.name ?? 'user'}.json`;
      const target = sanitizeUserPath(relativeTarget, root);
      if (!target.endsWith('.json')) {
        throw new PlaywrightMcpError(`path must end in .json: ${relativeTarget}`, 'INVALID_PATH');
      }
      const shown = relativeToRoot(root, target);

      let verifyUrl: string | undefined;
      if (args.verify?.url) {
        verifyUrl = new URL(args.verify.url, url).toString();
        assertHttpUrl(verifyUrl);
        await assertUrlAllowed(verifyUrl);
      }
      const visible = args.verify?.visible ? parseLocator(args.verify.visible) : undefined;
      const loginVerify = args.verify ? { url: verifyUrl, visible, notUrl: args.verify.notUrl } : undefined;
      const hasCheck = !!(visible || args.verify?.notUrl);

      // A fresh login never starts from a session (PW_MCP_STORAGE_STATE included).
      const { storageState: _default, ...base } = await resolvePageState(
        { headers: args.headers, viewport: args.viewport, actionTimeoutMs: args.actionTimeoutMs, actions: args.actions },
        root,
        url,
        ctx,
      );
      const common = (state: ResolvedPageState): Omit<BrowserScriptConfig, 'url' | 'mode'> => ({
        ...state,
        projectRoot: root,
        loginVerify,
        gotoTimeout: Math.min(30_000, Math.max(5_000, timeoutMs - 5_000)),
        waitTimeout: 10_000,
        startedAt: Date.now(),
      });

      // 1. A saved session that still works is kept.
      const existing = await stat(toNativePath(target)).catch(() => null);
      if (existing?.isFile() && args.reuse !== false && hasCheck) {
        const check = await runBrowserScript(
          {
            ...common({ headers: base.headers, viewport: base.viewport }),
            loginVerify: { ...loginVerify, url: undefined },
            mode: 'login',
            url: verifyUrl ?? url,
            storageState: toNativePath(target),
            loginCheckOnly: true,
          },
          { timeoutMs, signal: ctx.signal },
        );
        const scan = check.ok ? check.data?.login : undefined;
        if (scan?.verified === true) {
          return toolText(
            [
              `## ✅ STILL VALID — \`${shown}\``,
              '',
              `The saved session passed the check at ${verifyUrl ?? url}, so no new login was needed.`,
              '',
              ...scanLines(scan),
              '',
              `Use it with \`storageState: '${shown}'\` in the page tools, or \`use: { storageState: '${shown}' }\` in playwright.config.`,
            ].join('\n'),
            { status: 'valid', valid: true, path: shown, url: verifyUrl ?? url, ...(scan.firstExpiry ? { expiresAt: new Date(scan.firstExpiry * 1000).toISOString() } : {}) },
          );
        }
      }

      if (!args.actions?.length) {
        throw new PlaywrightMcpError('Pass the login steps in actions', 'INVALID_INPUT', {
          hint: existing?.isFile()
            ? `The saved session \`${shown}\` ${hasCheck ? 'failed the check' : 'cannot be checked without verify.visible or verify.notUrl'}, so a new login is needed.`
            : "E.g. fill getByLabel('Email') with {{env:E2E_USER}}, fill getByLabel('Password') with {{env:E2E_PASSWORD}}, click getByRole('button', { name: 'Sign in' }).",
        });
      }

      // 2. Log in, check, save.
      const env: Record<string, string> = {};
      const values = resolveLoginValues(args.actions);
      if (Object.keys(values).length > 0) env.PW_MCP_FILL_VALUES = JSON.stringify(values);
      const wantsTotp = args.actions.some((a) => a.type === 'fill' && TOTP_TOKEN_RE.test(a.value ?? ''));
      if (wantsTotp) {
        const name = args.totpSecretEnv;
        if (!name) throw new PlaywrightMcpError('{{totp}} needs totpSecretEnv', 'INVALID_INPUT', { hint: 'Name the environment variable that holds the authenticator secret, e.g. E2E_TOTP_SECRET.' });
        if (!loginEnvAllowed(name)) {
          throw new PlaywrightMcpError(`${name} is not an allowed login variable`, 'INVALID_INPUT', {
            hint: 'Name it E2E_*, TEST_*, PW_*, PLAYWRIGHT_* or LOGIN_* (e.g. E2E_TOTP_SECRET), or list it in PW_MCP_LOGIN_ENV.',
          });
        }
        const secret = process.env[name];
        if (!secret) throw new PlaywrightMcpError(`${name} is not set in the server's environment`, 'INVALID_INPUT');
        const totp = parseTotpSecret(secret);
        env.PW_MCP_TOTP = JSON.stringify({ key: totp.key.toString('hex'), digits: totp.digits, period: totp.period, algorithm: totp.algorithm });
      }

      const outcome = await runBrowserScript({ ...common(base), mode: 'login', url }, { timeoutMs, signal: ctx.signal, env });
      if (!outcome.ok) {
        const done = outcome.actionsDone?.length ? `\nSteps done: ${outcome.actionsDone.join(' → ')}` : '';
        return toolError(outcome.kind ?? 'UNKNOWN', `Login on ${url} failed: ${outcome.error ?? 'unknown error'}${done}`, outcome.hint, outcome.stderrTail);
      }
      const scan = outcome.data?.login;
      if (!scan) return toolError('UNKNOWN', 'The browser returned no session.', undefined, outcome.stderrTail);

      if (scan.verified === false) {
        return toolText(
          [
            `## ❌ LOGIN FAILED — nothing saved`,
            '',
            `The steps ran, but the check failed: ${scan.verifyNote || 'the session did not work'}. Ended on ${outcome.data?.finalUrl ?? url}.`,
            '',
            '**How to fix:** check the credentials in the environment, add a `wait` step for the page after sign-in, or run **inspect-page** with the same actions to see where the login stops (an MFA prompt, a consent screen, an error message).',
          ].join('\n'),
          { ok: false, status: 'failed', valid: false, path: shown, url },
        );
      }

      await writeFileInsideRoot(target, `${JSON.stringify(scan.state, null, 2)}\n`, root);

      const lines = [`## ✅ SAVED — \`${shown}\``, ''];
      lines.push(
        scan.verified === true
          ? `Logged in and checked: the session works${verifyUrl ? ` on ${verifyUrl}` : ''}.`
          : 'Logged in. No check was given, so the session was saved without one; add `verify` so expired sessions are caught next time.',
        '',
        ...scanLines(scan),
      );
      if (scan.cookies === 0 && scan.origins === 0) {
        lines.push('', '> ⚠️ The session is empty: no cookies or local storage were set. The login may not have finished; end the steps with a `wait` on the signed-in page.');
      }
      if (literalPasswordStep(args.actions)) {
        lines.push('', '> 🔐 A password was typed as plain text, so it is now in this chat. Put it in an environment variable (E2E_PASSWORD) and write `{{env:E2E_PASSWORD}}` instead.');
      }
      if (!(await ignoredByGit(root, shown))) {
        lines.push('', `> ⚠️ \`${shown}\` holds live session cookies and is not in .gitignore. Add \`${path.posix.dirname(shown)}/\` to .gitignore so it is never committed.`);
      }
      lines.push(
        '',
        `**Use it:** \`storageState: '${shown}'\` in inspect-page, validate-selector and the audits, or \`use: { storageState: '${shown}' }\` in playwright.config. Call save-login again before a run: it keeps the session while it works and logs in again when it expires.`,
      );
      return toolText(lines.join('\n'), {
        status: 'saved',
        valid: true,
        path: shown,
        url,
        ...(scan.firstExpiry ? { expiresAt: new Date(scan.firstExpiry * 1000).toISOString() } : {}),
      });
    }),
};
