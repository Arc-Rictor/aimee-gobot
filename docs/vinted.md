# Vinted UK Connector — Full Guide

Automate listing items on **vinted.co.uk** end to end: you provide photos, Claude
analyses them and writes the listing, the connector fills Vinted's form in a real
browser and saves a **draft**, you approve, it publishes.

- Code: [`mcp-servers/vinted/`](../mcp-servers/vinted)
- CLI: [`scripts/vinted-list.ts`](../scripts/vinted-list.ts) (`bun run vinted:list …`)
- Quick start: [`mcp-servers/vinted/README.md`](../mcp-servers/vinted/README.md)

---

## 1. How it works (and why this way)

**Vinted has no public/official seller API.** You cannot get an API key to create
listings. So the connector drives the actual website with [Playwright](https://playwright.dev)
(headless Chromium), using *your* logged-in session — exactly what a browser
extension would do, but scripted.

```
 photos ──► Claude (vision)  ──►  Listing object  ──►  Playwright fills
            writes title,          (title, category,    vinted.co.uk form
            description,            condition, price…)        │
            picks category,                                   ▼
            condition, price                            saved as DRAFT
                                                              │
                                            human reviews screenshot / draft
                                                              │
                                                       vinted_publish ──► live
```

The **draft-then-approve** split is deliberate: nothing goes live until you say
so, which protects you from a mis-priced or mis-categorised auto-listing and
keeps activity looking human.

## 2. The honest caveats

Read these once.

- **Terms of Service.** Vinted's ToS discourage automated/bot access. This is
  your own account listing your own items, which is legitimate personal
  automation, but aggressive use *can* get an account restricted. Keep volumes
  reasonable and review drafts.
- **Anti-bot (DataDome).** Vinted fingerprints traffic and may show a captcha,
  especially on a new session or from an unfamiliar IP. Mitigations built in:
  a persistent real browser profile, a normal user-agent, UK locale/timezone,
  and jittered pauses in bulk mode. When a captcha appears, run with
  `VINTED_HEADED=1` (or use `vinted_login`) and solve it by hand once.
- **The UI changes.** Selectors will eventually break. They're all in one file
  ([`selectors.ts`](../mcp-servers/vinted/selectors.ts)) with multiple fallbacks
  each — see §6.
- **First real run needs a human.** Treat the first listing as a calibration:
  run headed, watch which fields fill, tune selectors if needed. After that it's
  reliable until Vinted changes something.

## 3. Running it on a separate laptop

The connector is self-contained and portable. On the laptop that will run it:

```bash
git clone <your-repo-url> aimee-gobot
cd aimee-gobot
bun install                 # installs the playwright npm package
bun run vinted:setup        # downloads Chromium for Playwright (~150MB, once)
bun run vinted:list login   # opens a browser; log in to Vinted by hand
bun run vinted:list check   # ✅ session valid
```

That's it — no API keys, no database, no VPS required for the Vinted connector
itself. Everything it needs is the logged-in browser profile in
`~/.gobot/vinted-profile` on that laptop.

- **Keep the laptop the one that logs in.** The session profile is tied to the
  machine; copying it between machines can invalidate it or trip anti-bot. Just
  run `vinted:list login` once per machine.
- **To drive it from Claude on that laptop**, install Claude Code / Cowork there
  and add the MCP server (see README), pointing at the absolute repo path on
  that laptop.
- **Runs offline-ish.** Only outbound HTTPS to vinted.co.uk is needed.

## 4. The "you supply photos" workflow (recommended)

This is the headline use case. With the MCP server wired into Claude Cowork /
Claude Code:

1. Make a folder per item and drop the photos in (any names; or `01.jpg`,
   `02.jpg`… to fix the order — the first is the cover).
2. Tell Claude, e.g.:
   > "List the item in `./listings/winter-coat` — look at the photos, identify
   > it, write a good title and description, pick the category, condition and a
   > fair UK price, and save a Vinted draft."
3. Claude views the photos, composes the listing, and calls `vinted_create_draft`.
4. You get a screenshot + a per-field report. If happy:
   > "Publish it."
   Claude calls `vinted_publish`.

Claude does the cataloguing, copywriting, pricing research and form-filling. You
do photos + a final glance. That scales to a stack of items in one session.

### Pricing help
Ask Claude to check comparable sold/active listings for a fair price, or set your
own rule ("price at 40% of retail, round to £X.99"). Pricing lives in the
listing object, so you stay in control.

## 5. Batch / scale via the CLI

For deterministic bulk runs (or cron), give each item a folder with an
`item.json` ([schema](../mcp-servers/vinted/types.ts)) and photos:

```
listings/
  winter-coat/      item.json  +  01.jpg 02.jpg …
  nike-airmax/      item.json  +  *.jpg
```

```bash
bun run vinted:list draft-all ./listings   # drafts each, pausing between items
bun run vinted:list drafts                 # review titles + URLs
bun run vinted:list publish <url>          # publish the ones you approve
```

`item.json` can be hand-written or generated by Claude per folder. Leave
`"photos": []` to auto-use every image in the folder (sorted by filename).

Bulk mode pauses `VINTED_BULK_DELAY_MS` (default 20s, jittered) between items to
stay under the anti-bot radar. Raise it if you list many at once.

## 6. When a field stops filling (selector tuning)

Vinted shipped a UI change — symptoms: a field reports `failed` / `skipped`.

1. Re-run the single item headed and with debug:
   ```bash
   VINTED_HEADED=1 VINTED_DEBUG=1 bun run vinted:list draft ./listings/example-trainers
   ```
2. Watch which field doesn't fill; check the screenshot in `.vinted-shots/`.
3. Open the form in a normal browser, right-click the field → Inspect, and grab
   a stable attribute (prefer `data-testid`, `id`, `name`, or the visible label).
4. Add it to the front of that field's candidate list in
   [`selectors.ts`](../mcp-servers/vinted/selectors.ts). That's the only file you
   touch — the flow logic in `vinted-client.ts` stays put.

## 7. Field reference

The `Listing` object Claude fills ([`types.ts`](../mcp-servers/vinted/types.ts)):

| Field | Required | Notes |
|-------|----------|-------|
| `photos` | ✓ | 1–20 absolute paths; first = cover |
| `title` | ✓ | ≤100 chars, searchable |
| `description` | ✓ | be honest about flaws |
| `category` | ✓ | path, e.g. `["Men","Shoes","Trainers"]` |
| `condition` | ✓ | New with tags / New without tags / Very good / Good / Satisfactory |
| `price` | ✓ | GBP, e.g. `38` → £38.00 |
| `brand` | — | as in Vinted brand search |
| `size` | — | exactly as Vinted lists it for the category |
| `colors` | — | up to 2 |
| `material` | — | e.g. Cotton |
| `parcelSize` | — | small / medium / large (default small) |
| `notes` | — | for Claude only; not sent to Vinted |

## 8. Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Not logged in" on draft | `bun run vinted:list login` (headed, finish within the window) |
| Browser command hangs on launch (no window, no output, times out) | You don't have Node, or a script was switched back to `bun run`. Playwright can't drive a browser under bun (§9). Install Node, reopen the terminal; keep `vinted:list`/`vinted:mcp` on `tsx`. |
| `'node' is not recognized` / `tsx: command not found` | Install Node LTS and reopen the terminal so it's on PATH (§9). |
| Captcha / "unusual activity" | run `VINTED_HEADED=1`, solve by hand once; slow down bulk runs |
| `saveDraft` reports failed / "too many symbol characters" | Vinted rejected the title — remove em-dashes (—), slashes and symbol runs, then retry. The connector checks the real save (HTTP 200), so this is surfaced, not hidden. |
| A field reports `failed` | tune `selectors.ts` (§6) |
| Chromium won't launch | `bun run vinted:setup`, or set `VINTED_CHROMIUM_PATH` |
| Session keeps dropping | don't copy the profile between machines; log in per machine |
| Want to see what it's doing | `VINTED_HEADED=1` |

## 9. Runtime: Node is required for the browser commands

The browser-driving commands (`vinted:list`, `vinted:mcp`) run under **Node**, not
bun. Playwright can't control a browser under bun — bun doesn't pass through the
extra stdio pipe (`--remote-debugging-pipe`) Playwright uses, so the launch hangs
forever even though the browser itself starts fine. Under Node the same call
connects in well under a second.

So those two `package.json` scripts are defined as `tsx …`. You still type
`bun run vinted:list …` exactly as documented — bun just shells out to `tsx`, which
runs under Node. The rest (`vinted:setup`, `vinted:upload`) stays on bun.

**Setup adds one step:** install Node LTS (e.g. `winget install OpenJS.NodeJS.LTS`,
or unzip the official Windows build into a folder and add it to your PATH), then
`bun add -d tsx` (already in `devDependencies` here). Reopen the terminal so Node is
on PATH. That's the only change from a pure-bun setup.
