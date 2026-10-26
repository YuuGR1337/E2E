/**
 * Vercel function entry point — `POST /api/mcp` speaks MCP over Streamable
 * HTTP. The handler is created once per warm lambda; each request still gets
 * its own server instance (the SDK's stateless mode), so no session state
 * survives between requests.
 *
 * Set PW_MCP_HTTP_TOKEN in the Vercel project to serve all tools to callers
 * that send it as a bearer token (16+ characters, or the function refuses to
 * start); without it only read-only tools are served, in restricted mode.
 *
 * The page tools launch the serverless Chromium build imported here; the
 * static import lets the function bundler trace it.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import chromium from '@sparticuz/chromium';
import { createMcpHttpHandler, handleNodeRequest, provideServerlessChromium } from '../dist/http.js';

provideServerlessChromium(chromium);

const handler = createMcpHttpHandler();

export default function mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleNodeRequest(handler, req, res);
}
