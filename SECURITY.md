# Security policy

## Supported versions

Security fixes go into the latest release on npm (`playwright-e2e-mcp`). Please upgrade
before reporting.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub:
[Report a vulnerability](https://github.com/xsignon-secure/E2E/security/advisories/new).

Include what an attacker can do, the steps or a proof of concept, and the version and
transport (stdio or the HTTP bridge). We aim to acknowledge reports within 3 working days
and to ship a fix or mitigation within 30 days for confirmed issues, and will credit you in
the release notes unless you prefer otherwise.

## Scope

In scope: path sandbox escapes, command or argument injection into Playwright or git,
SSRF past the URL guard, the HTTP bridge's auth and environment isolation, and anything
that lets a tool caller read or write outside the project root.

Out of scope: test code you run yourself (it runs with your permissions by design), and
issues in Playwright or the MCP SDK themselves (report those upstream).

The server's security model is described under
[Security notes](README.md#security-notes) in the README.
