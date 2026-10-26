/**
 * Serverless Chromium for the hosted bridge. A Vercel function has no
 * Playwright browser download, so the page tools launch the Chromium build
 * from `@sparticuz/chromium` (a dev dependency, bundled into the function by
 * vercel.json) with the project's Playwright driving it.
 *
 * On by default on Vercel; PW_MCP_SERVERLESS_CHROMIUM=1 turns it on
 * elsewhere (Linux x64 only, Node 22+) and `0` turns it off.
 */

import { isHostedDeployment } from './project-detector.js';

export interface ServerlessChromium {
  executablePath: string;
  args: string[];
  /** Library and font paths the binary needs, for the probe child's env. */
  env: Record<string, string>;
}

const MODULE = '@sparticuz/chromium';

interface ChromiumModule {
  executablePath(): Promise<string>;
  args: string[];
}

let provided: ChromiumModule | undefined;
let loading: Promise<ServerlessChromium | null> | undefined;

/**
 * Hand over the imported module. The Vercel entry point imports it
 * statically so the function bundler traces it and its dependencies.
 */
export function provideServerlessChromium(chromium: ChromiumModule): void {
  provided = chromium;
}

export function serverlessChromiumEnabled(): boolean {
  const flag = process.env.PW_MCP_SERVERLESS_CHROMIUM;
  if (flag === '0') return false;
  return flag === '1' || isHostedDeployment();
}

/**
 * The extracted binary and its launch flags, or null when serverless
 * Chromium is off or not installed. Extraction to the temp dir happens
 * once per warm instance.
 */
export function serverlessChromium(): Promise<ServerlessChromium | null> {
  if (!serverlessChromiumEnabled()) return Promise.resolve(null);
  loading ??= load().catch((err: unknown) => {
    loading = undefined;
    throw err;
  });
  return loading;
}

async function load(): Promise<ServerlessChromium | null> {
  let chromium = provided;
  if (!chromium) {
    try {
      // A variable specifier keeps tsc from resolving an optional module.
      const name = MODULE;
      chromium = ((await import(name)) as { default: ChromiumModule }).default;
    } catch {
      return null;
    }
  }
  const executablePath = await chromium.executablePath();
  // Importing the module sets these on process.env for Amazon Linux;
  // the probe child gets a scrubbed env on the bridge, so pass them on.
  const env: Record<string, string> = {};
  for (const key of ['LD_LIBRARY_PATH', 'FONTCONFIG_PATH']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return { executablePath, args: chromium.args, env };
}
