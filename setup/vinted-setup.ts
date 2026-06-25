#!/usr/bin/env bun
/**
 * One-command setup for the Vinted UK connector on a fresh machine (e.g. your
 * laptop). Installs the Chromium build Playwright needs, then prints next steps.
 *
 *   bun run vinted:setup
 */

import { spawnSync } from "child_process";

console.log("🛠  Setting up the Vinted UK connector…\n");

// In sandboxed/managed environments Chromium is preinstalled and exposed via
// PLAYWRIGHT_BROWSERS_PATH — skip the download there.
if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
  console.log(`• Detected PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH} — using preinstalled Chromium.`);
} else {
  console.log("• Installing Chromium for Playwright (this downloads ~150MB once)…");
  const res = spawnSync("bunx", ["playwright", "install", "chromium"], { stdio: "inherit" });
  if (res.status !== 0) {
    console.error("\n❌ Chromium install failed. Try manually: bunx playwright install chromium");
    process.exit(1);
  }
}

console.log(`
✅ Connector ready.

Next steps:
  1. Log in once (opens a real browser window — solve any captcha by hand):
       bun run vinted:list login

  2. Confirm the session is saved:
       bun run vinted:list check

  3. Draft a listing from a folder of photos:
       bun run vinted:list draft ./listings/example-trainers

  4. Review the screenshot it prints, then publish:
       bun run vinted:list publish <draftUrl>

To drive it conversationally from Claude Cowork / Claude Code instead, add the
MCP server to your config — see mcp-servers/vinted/README.md.

The login session is stored in ~/.gobot/vinted-profile (override with
VINTED_PROFILE_DIR). Keep it on the machine that will run the connector.
`);
