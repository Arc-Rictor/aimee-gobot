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
and pushed. **Login now works and the session is valid** (`vinted:list check` →
`✅ Session valid`). The real blocker turned out NOT to be a stale browser process
(see saga #6) but a **bun ↔ Playwright incompatibility** — now fixed by running the
browser commands under Node. Drafting/listing has **not been tested against live
Vinted yet** — that is the current step.

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
6. We *thought* `doctor` hung because a **stale "Chrome for Testing" process held
   the profile**, and added a 45s launch timeout + error (`browser.ts`). That was a
   red herring — there was no stale process.
7. **Actual root cause (resolved):** Playwright cannot drive a browser **under
   bun**. Bun doesn't pass through the extra stdio pipe fds Playwright's
   `--remote-debugging-pipe` transport needs, so `launchPersistentContext` hangs
   until timeout (and `connectOverCDP` over WebSocket hangs too). Proven: the
   browser launches fine, loopback HTTP + raw CDP round-trips work under bun, but
   Playwright's own connection layer never connects. The identical call succeeds in
   <1s under **Node**. **Fix:** the two browser-driving scripts (`vinted:list`,
   `vinted:mcp`) now run under Node via `tsx` in `package.json`; everything else
   stays on bun. `bun run vinted:list …` still works (bun shells out to `tsx`).
   Node must be installed + on PATH (here: portable Node 24 at
   `C:\Users\vanil\nodejs\...`, added to the user PATH). See CLAUDE.md "Runtime"
   and docs/vinted.md §9.

### Immediate next step
Login is done. Current step is **testing a real draft** (see roadmap §1 below) and
**tuning `selectors.ts`** against the live Vinted UK form. Never auto-publish.

Prereq on a fresh machine: Node must be on PATH (see saga #7). On this laptop it
already is. Sanity check anytime: `bun run vinted:list check` → `✅ Session valid`.

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
