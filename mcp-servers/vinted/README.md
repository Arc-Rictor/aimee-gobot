# Vinted UK Connector

Automate listing items for sale on **vinted.co.uk**. You supply photos; Claude
analyses them, writes the listing, fills Vinted's "List an item" form via a real
browser, saves it as a **draft**, and (after you approve) publishes it.

There is no official Vinted API — this drives the real website with Playwright,
using *your* logged-in session on *your* machine. See [`docs/vinted.md`](../../docs/vinted.md)
for the full guide, the anti-bot/ToS reality, and selector tuning.

## Quick start (on the laptop that will run it)

```bash
bun install
bun run vinted:setup          # installs Chromium for Playwright
bun run vinted:list login     # opens a browser — log in to Vinted by hand, once
bun run vinted:list check     # confirms the session is saved
bun run vinted:list draft ./listings/example-trainers   # build a draft
# review the screenshot it prints, then:
bun run vinted:list publish <draftUrl>
```

The login session lives in `~/.gobot/vinted-profile` (override with
`VINTED_PROFILE_DIR`). It stays on the machine — nothing is uploaded anywhere.

## Two ways to use it

### 1. Conversational (Claude Cowork / Claude Code) — the "you supply photos" flow

Add this MCP server to your Claude config, then just talk to Claude:
*"List the trainers in `./listings/example-trainers` — look at the photos,
write the listing and save a draft."*

> **The MCP server must run under Node, not bun** — Playwright can't drive a
> browser under bun (see [`docs/vinted.md`](../../docs/vinted.md) §9). So the
> `command` below points at `node.exe` running the project's bundled `tsx` (which
> runs the TypeScript server with no build step). Using `bun` here will hang.

**Claude Desktop (Windows)** — edit
`%APPDATA%\Claude\claude_desktop_config.json` (absolute paths, double-backslashes):

```json
{
  "mcpServers": {
    "vinted-uk": {
      "command": "C:\\Users\\YOU\\nodejs\\node-vXX-win-x64\\node.exe",
      "args": [
        "C:\\Users\\YOU\\aimee-gobot\\node_modules\\tsx\\dist\\cli.mjs",
        "C:\\Users\\YOU\\aimee-gobot\\mcp-servers\\vinted\\server.ts"
      ],
      "env": { "VINTED_SHOT_DIR": "C:\\Users\\YOU\\aimee-gobot\\.vinted-shots" }
    }
  }
}
```

If Node is on your PATH you can use `"command": "node"`. On Mac/Linux use forward
slashes and your Node/project paths. For **Claude Code**, add the same server with
`claude mcp add vinted-uk -- <node> <…/tsx/dist/cli.mjs> <…/server.ts>` or in
`.mcp.json`.

Restart Claude Desktop after editing. To list an item: keep its photos in a folder,
**attach them to the chat** so Claude can see them, and say *"list these — photos
are in `C:\Users\YOU\aimee-gobot\listings\item1`"*. Claude researches a price
(`vinted_research_price`), composes the listing, and calls `vinted_create_draft`
with that `photoDir`.

Tools exposed:

| Tool | Does |
|------|------|
| `vinted_check_session` | Is there a valid logged-in session? |
| `vinted_login` | Open a browser to log in by hand (local, has a display) |
| `vinted_research_price` | Suggest a GBP price from comparable active listings |
| `vinted_create_draft` | Fill the form from photos + details, **save as draft** |
| `vinted_list_drafts` | List current drafts + URLs for review |
| `vinted_publish` | Publish an approved draft live |

`vinted_create_draft` never publishes — that's always a separate, approved step.

### 2. Batch CLI — for scale / cron

Each item is a folder with photos + an `item.json` (schema = the `Listing` type
in [`types.ts`](./types.ts)). See [`listings/example-trainers`](../../listings/example-trainers).

```bash
bun run vinted:list draft-all ./listings    # draft every subfolder, with
                                            # human-like pauses between items
bun run vinted:list drafts                  # review URLs
bun run vinted:list publish <url>           # publish one you approve
```

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `VINTED_PROFILE_DIR` | `~/.gobot/vinted-profile` | Where the logged-in session is stored |
| `VINTED_HEADED` | `0` | `1` = show the browser while drafting/publishing (useful for captchas) |
| `VINTED_DEBUG` | `0` | `1` = extra logging + screenshots |
| `VINTED_SHOT_DIR` | `./.vinted-shots` | Where review screenshots are written |
| `VINTED_BULK_DELAY_MS` | `20000` | Base pause between bulk drafts (jittered) |
| `VINTED_BASE_URL` | `https://www.vinted.co.uk` | The Vinted site to drive |
| `VINTED_CHROMIUM_PATH` | _(auto)_ | Override the Chromium binary path |

## Heads-up

Vinted changes its UI without notice and uses anti-bot protection. When a field
stops filling, edit [`selectors.ts`](./selectors.ts) (the one place selectors
live) and re-run with `VINTED_DEBUG=1`. Keep volumes modest and review drafts —
this is your account. Full detail in [`docs/vinted.md`](../../docs/vinted.md).
