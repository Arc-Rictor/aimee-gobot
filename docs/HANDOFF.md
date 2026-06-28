# Session handoff — continue here

> For the next Claude (e.g. Claude Code CLI on the user's Windows laptop).
> Read this top to bottom, then continue from **Where we are**. The project
> guide is `CLAUDE.md`; full docs are `docs/vinted.md`.

## TL;DR of the project

A standalone **Vinted UK lister**. User supplies photos; Claude writes the
listing; a Playwright-driven real browser saves a **draft** on vinted.co.uk; the
user approves; it publishes. No official API — everything is browser automation.
Never auto-publish. Runs on the user's **Windows laptop** (user: `vanil`, repo at
`C:\Users\vanil\aimee-gobot`).

Key commands:
```
bun run vinted:setup                 # install Chromium for Playwright
bun run vinted:list login            # log in by hand (headed), once
bun run vinted:list doctor           # clean headless diagnostic
bun run vinted:list cookies          # show saved Vinted cookies
bun run vinted:list check            # is the session valid?
bun run vinted:list draft <folder>   # draft one item
bun run vinted:upload                # LAN page to upload phone photos
bun run vinted:mcp                   # MCP server (stdio)
```

## Where we are

The connector, MCP server, batch CLI, and phone photo-upload server are all built
and pushed. We are **mid-debugging the one-time Vinted login on the laptop.**
Drafting/listing has **not been tested against live Vinted yet** — that's next
after login works.

### The login saga so far (so you don't repeat fixes)
Symptoms seen, in order, and what was done:
1. Headed browser opened but sat on `about:blank` → switched navigation to
   `waitUntil:"commit"` with retries + logging (`navigate()` in `vinted-client.ts`).
2. Manual login not detected → replaced fragile DOM-element detection with
   **auth-cookie detection** (`hasAuthCookie()`), and dropped a fake user-agent.
3. Still not detected → Vinted sets the session cookie on the apex `vinted.co.uk`
   (no `www`); detection was filtering to `www`. Fixed: read the **whole cookie
   jar** and filter by the `vinted` domain (`vintedCookies()`). Auth regex is
   `/(access|refresh)_token/i`.
4. `login` made self-diagnosing: prints `cookies so far: …` live so a name
   mismatch is visible.
5. User confirmed the browser that opens is **"Chrome for Testing"** — that is
   correct (it's Playwright's bundled Chromium, not their normal Chrome).
6. **Current blocker:** `doctor` hangs at "Launching headless browser…". Diagnosis:
   a **stale "Chrome for Testing" process holds the persistent profile**
   (`C:\Users\vanil\.gobot\vinted-profile`), so the next launch waits forever.
   Added a 45s launch timeout + a clear error (`browser.ts`). Only one process can
   use the profile at a time.

### Immediate next step for the user
1. Close ALL "Chrome for Testing" windows; end any "Chrome for Testing" tasks in
   Task Manager (leave normal Chrome alone).
2. `git pull` then `bun run vinted:list doctor` — expect a clean block ending with
   `Reached URL: https://www.vinted.co.uk/` and an auth-cookie line.
3. `bun run vinted:list login`, logging in **inside the Chrome for Testing window**.
   Watch for `✅ Login detected — session saved`, then `bun run vinted:list check`.

Golden rule for the user: let `login` finish (or close its window) before running
another command, so the profile isn't locked.

## After login works — the roadmap
1. **Test a real draft.** Put photos in `listings/<item>/` (or use
   `bun run vinted:upload` from the phone), then
   `VINTED_HEADED=1 bun run vinted:list draft ./listings/<item>` (PowerShell:
   `$env:VINTED_HEADED=1`). Watch which fields fill. Expect to **tune selectors**
   in `mcp-servers/vinted/selectors.ts` against the live Vinted UK form — this is
   the one file for selectors; each field has ordered fallbacks. Screenshots land
   in `.vinted-shots/`. The draft flow never publishes.
2. **Connect Claude Desktop / Claude Code** as an MCP client so the user can list
   conversationally (drop photos → Claude writes listing → `vinted_create_draft`).
   Config snippets (Windows + Mac) are in `mcp-servers/vinted/README.md`.
3. Optional: "upload + approve from phone" — extend the upload page with a draft
   review/publish screen.

## Map of the code
| File | Role |
|------|------|
| `mcp-servers/vinted/types.ts` | Listing schema (zod) + `DraftInput` (photoDir) |
| `mcp-servers/vinted/browser.ts` | Chromium resolution + persistent profile + launch timeout |
| `mcp-servers/vinted/selectors.ts` | **Vinted UK form selectors — tune here** |
| `mcp-servers/vinted/photos.ts` | Resolve photos from paths or a folder |
| `mcp-servers/vinted/vinted-client.ts` | Playwright flow: login, cookie detect, draft, publish, diagnose |
| `mcp-servers/vinted/server.ts` | MCP server (5 tools) |
| `scripts/vinted-list.ts` | Batch CLI (login/check/doctor/cookies/draft/draft-all/drafts/publish) |
| `scripts/vinted-upload-server.ts` | LAN phone photo-upload page |
| `setup/vinted-setup.ts` | One-command setup |

## Repo / git notes
- This repo (`Arc-Rictor/aimee-gobot`) was converted from the old "gobot" project
  to be **only** this Vinted lister. Old gobot code is preserved on the
  `archive/gobot` branch.
- `master` and `claude/vinted-uk-connector-ka6dnh` are kept in sync (same tip).
  Work on whichever; push both or fast-forward one to the other.
- Build check: `bun run typecheck` (tsc, must stay clean).
- No PRs unless the user asks.
