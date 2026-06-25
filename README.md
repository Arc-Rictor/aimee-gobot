# Vinted UK Lister

Automate listing items for sale on **vinted.co.uk**. You supply the photos;
Claude analyses them, writes the listing (title, description, category,
condition, price), fills Vinted's "List an item" form in a real browser, saves a
**draft**, and — after you approve — publishes it.

There is no official Vinted seller API, so this drives the real website with
[Playwright](https://playwright.dev) using *your* logged-in session on *your*
machine. It never publishes without your say-so.

> 📖 Full guide, including the anti-bot/Terms-of-Service reality and how to tune
> selectors when Vinted changes its UI: **[`docs/vinted.md`](docs/vinted.md)**

---

## Quick start

On the machine that will run it (a normal laptop — Windows, Mac or Linux):

```bash
bun install
bun run vinted:setup          # installs Chromium for Playwright (once)
bun run vinted:list login     # a browser opens — log into Vinted by hand, once
bun run vinted:list check     # → ✅ Session valid
bun run vinted:list draft ./listings/example-trainers   # build a draft
# review the screenshot it prints, then:
bun run vinted:list publish <draftUrl>
```

Your login session is stored locally in `~/.gobot/vinted-profile` (override with
`VINTED_PROFILE_DIR`). Nothing is uploaded anywhere — the bot never sees your
password.

## Two ways to use it

### 1. Conversational — Claude Desktop / Claude Code (the "just give it photos" flow)

Add the MCP server to your Claude config, then talk to Claude: drop an item's
photos in a folder, attach them to the chat so Claude can see them, and say
*"list these — photos are in `…/item1`"*. Claude writes the listing and saves a
draft for your approval.

**Claude Desktop (Windows)** — edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vinted-uk": {
      "command": "C:\\Users\\YOU\\.bun\\bin\\bun.exe",
      "args": ["run", "C:\\Users\\YOU\\vinted-uk-lister\\mcp-servers\\vinted\\server.ts"]
    }
  }
}
```

**Claude Desktop (Mac) / Claude Code** — `~/.claude.json` or `.mcp.json`:

```json
{
  "mcpServers": {
    "vinted-uk": {
      "command": "bun",
      "args": ["run", "/ABSOLUTE/PATH/TO/vinted-uk-lister/mcp-servers/vinted/server.ts"]
    }
  }
}
```

Restart Claude after editing. Tools exposed:

| Tool | Does |
|------|------|
| `vinted_check_session` | Is there a valid logged-in session? |
| `vinted_login` | Open a browser to log in by hand (local, has a display) |
| `vinted_create_draft` | Fill the form from photos + details, **save as draft** |
| `vinted_list_drafts` | List current drafts + URLs for review |
| `vinted_publish` | Publish an approved draft live |

### 2. Batch CLI — for scale / cron

Each item is a folder with photos + an `item.json` (schema = the `Listing` type
in [`mcp-servers/vinted/types.ts`](mcp-servers/vinted/types.ts)). See
[`listings/example-trainers`](listings/example-trainers).

```bash
bun run vinted:list draft-all ./listings    # draft every subfolder, with
                                            # human-like pauses between items
bun run vinted:list drafts                  # review URLs
bun run vinted:list publish <url>           # publish one you approve
```

## Project layout

```
mcp-servers/vinted/
  types.ts          # Listing schema (what Claude fills in)
  browser.ts        # Chromium resolution + persistent logged-in session
  selectors.ts      # Centralised Vinted UK form selectors (tune here if UI changes)
  photos.ts         # Photo resolution (explicit paths or a folder)
  vinted-client.ts  # Playwright automation: login, draft, publish, list drafts
  server.ts         # MCP server (the tools above)
  README.md         # Connector reference
scripts/vinted-list.ts   # Batch CLI
setup/vinted-setup.ts    # One-command setup for a fresh machine
listings/example-trainers/   # Example item "brief"
docs/vinted.md           # Full guide
```

## Heads-up

Vinted changes its UI without notice and uses anti-bot protection. Keep volumes
modest, review drafts (it's your account), and if a field stops filling, edit
[`mcp-servers/vinted/selectors.ts`](mcp-servers/vinted/selectors.ts) — the one
place selectors live. Full detail in [`docs/vinted.md`](docs/vinted.md).

## Configuration

See [`.env.example`](.env.example) for the optional environment variables
(profile location, headed mode, debug, bulk pacing, etc.).
