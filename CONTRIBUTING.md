# Contributing to playwright-e2e-mcp

Thanks for helping. Bug reports, failing-test cases the server gets wrong, and pull
requests are all welcome.

## Reporting a bug

Open a [bug report](https://github.com/xsignon-secure/E2E/issues/new?template=bug_report.yml).
The most useful reports include the tool that misbehaved, the arguments you passed, what it
returned, and (if you can) a minimal Playwright test that reproduces it. Please remove
secrets, cookies and internal URLs from anything you paste.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Development setup

Node.js 22 or newer.

```bash
npm install
npx playwright install chromium
npm test        # build + unit tests
npm run coverage  # unit tests with a coverage report
npm run e2e     # build + live MCP ↔ Playwright integration suite
```

`src/` layout and the other scripts are described under
[docs/development.md](docs/development.md).

## Pull requests

- Keep each PR to one change and explain the why in the description.
- Add or update tests in `test/` (unit) or `e2e/` (integration) for behaviour changes.
- `npm test` must pass; CI also runs the e2e suite on Linux and Windows, macOS unit tests,
  the `.mcpb` bundle build, the Docker image and CodeQL.
- Tools are a public API: changing a tool's arguments or output shape needs a note in the
  PR and in `release-notes/`.
- If you change what a tool does, update `skill/playwright-e2e-mcp/` so agents keep
  using it correctly.

## Releases

Maintainers bump the version in `package.json`, `server.json`, `gemini-extension.json` and
`.claude-plugin/plugin.json`, add `release-notes/v<version>.md`, merge, and push the
`v<version>` tag. CI publishes npm, the MCP Registry and the GitHub release.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
