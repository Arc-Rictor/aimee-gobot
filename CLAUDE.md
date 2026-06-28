# Vinted UK Lister — project guide for Claude

This repo automates listing items for sale on **vinted.co.uk**. The user supplies
photos; you analyse them, write the listing, and the connector drives the real
Vinted website (via Playwright) to save a **draft**, which the user approves
before it's published.

## Golden rules

1. **Never auto-publish.** `vinted_create_draft` / `vinted:list draft` only ever
   save a draft. Publishing is always a separate, human-approved step
   (`vinted_publish` / `vinted:list publish <url>`).
2. **No official API exists** — everything goes through a real browser using the
   user's logged-in session. Don't try to call Vinted HTTP endpoints directly.
3. **Keep it human-paced.** Bulk runs already jitter pauses between items; don't
   remove that — it's what keeps the account under the anti-bot radar.
4. **Selectors live in one file.** When a form field stops filling, fix
   `mcp-servers/vinted/selectors.ts` (ordered candidate selectors, accessible
   roles preferred). Don't scatter selectors into the flow logic.

## The "photos → listing" job

When asked to list an item, you (Claude) do the cataloguing:
- View the photos and identify the item, brand, and any flaws.
- Write a searchable `title` and an honest `description` (mention defects).
  **Keep the title free of em-dashes (—), slashes and symbol runs** — Vinted
  rejects symbol-heavy titles ("too many symbol characters") and the draft save
  silently fails. Prefer plain words: "Nike Air Max 90 Trainers UK 9 White Grey".
- Choose the `category` path (broad→specific, e.g. `["Men","Shoes","Trainers"]`),
  `condition` (one of the five Vinted labels), `colors`, `size` (as Vinted lists
  it for the category), and a sensible **GBP** `price` (research comparables if asked).
- Call `vinted_create_draft` with either explicit `photos` paths or a `photoDir`
  folder. Report the per-field result + screenshot for the user to approve. The
  connector verifies the real save (HTTP 200) — if `saveDraft` reports failed, fix
  the flagged field (often the title) and retry.

The `Listing` schema is the contract: `mcp-servers/vinted/types.ts`.

## Architecture

| File | Role |
|------|------|
| `mcp-servers/vinted/types.ts` | Listing schema (zod) + draft result types |
| `mcp-servers/vinted/browser.ts` | Chromium resolution + persistent session profile |
| `mcp-servers/vinted/selectors.ts` | Vinted UK form selectors (the tunable surface) |
| `mcp-servers/vinted/photos.ts` | Resolve photos from explicit paths or a folder |
| `mcp-servers/vinted/vinted-client.ts` | Playwright flow: login, draft, publish, list |
| `mcp-servers/vinted/server.ts` | MCP server exposing the tools |
| `scripts/vinted-list.ts` | Batch CLI (`bun run vinted:list …`) |
| `scripts/vinted-upload-server.ts` | LAN web page to upload phone photos into `listings/` |
| `setup/vinted-setup.ts` | One-command setup for a fresh machine |

## Commands

```bash
bun run vinted:setup                 # install Chromium for Playwright
bun run vinted:list login            # log in by hand (headed), once
bun run vinted:list check            # is the session valid?
bun run vinted:list draft <folder>   # draft one item
bun run vinted:list draft-all <dir>  # draft every subfolder
bun run vinted:list drafts           # list current drafts
bun run vinted:list research "<q>"   # suggest a price from comparable listings
bun run vinted:list publish <url>    # publish an approved draft
bun run vinted:upload                # LAN photo-upload page (snap on phone → laptop)
bun run vinted:mcp                   # run the MCP server (stdio)
bun run typecheck                    # tsc --noEmit
```

## Environment

It runs on the user's own laptop (Windows is their target), not on a server —
datacenter IPs trip Vinted's anti-bot far more, and login/captcha need a display.
All config is optional env vars (see `.env.example`). No database, no keys
required. Full docs: `docs/vinted.md`.

## Runtime: browser commands run under Node, not bun

**Playwright cannot drive a browser under bun** — bun doesn't wire the extra
stdio file descriptors Playwright's `--remote-debugging-pipe` transport needs, so
`launchPersistentContext` hangs forever (and `connectOverCDP` over WebSocket hangs
too). Verified: the browser launches fine, raw CDP works, but Playwright's own
connection layer never connects under bun. The same call succeeds in <1s under Node.

So the two browser-driving scripts run under Node via `tsx`:
`vinted:list` and `vinted:mcp` are defined as `tsx …` in `package.json` (everything
else stays on bun). `bun run vinted:list …` still works — bun just shells out to
`tsx`, which runs under Node. **Node must be installed and on PATH** for this to
work (tsx's launcher invokes `node`). If a browser command errors with
`'node' is not recognized` or `tsx: command not found`, install Node LTS and reopen
the terminal. Don't switch these scripts back to `bun run` — it will hang on launch.
