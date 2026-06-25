#!/usr/bin/env bun
/**
 * Vinted UK batch CLI.
 *
 * For when you want to drive the connector directly (cron, scripts, bulk runs)
 * rather than conversationally through Claude. Each item is a *folder* containing
 * its photos and an `item.json` describing the listing.
 *
 * Usage:
 *   bun run vinted:list login                 # one-time: log in by hand (headed)
 *   bun run vinted:list check                 # is the saved session still valid?
 *   bun run vinted:list draft ./listings/my-item     # draft a single item
 *   bun run vinted:list draft-all ./listings          # draft every subfolder
 *   bun run vinted:list drafts                 # list current drafts + URLs
 *   bun run vinted:list publish <draftUrl>     # publish an approved draft
 *
 * item.json shape: see mcp-servers/vinted/types.ts (Listing). `photos` is
 * optional in the file — if omitted, every image in the folder is used, sorted
 * by filename (so name them 01.jpg, 02.jpg, … to control order).
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, resolve } from "path";
import { VintedClient } from "../mcp-servers/vinted/vinted-client.js";
import { ListingSchema, type Listing } from "../mcp-servers/vinted/types.js";
import { resolvePhotos } from "../mcp-servers/vinted/photos.js";

function loadListing(folder: string): Listing {
  const dir = resolve(folder);
  const jsonPath = join(dir, "item.json");
  if (!existsSync(jsonPath)) throw new Error(`No item.json in ${dir}`);
  const raw = JSON.parse(readFileSync(jsonPath, "utf8"));

  // Photos: explicit list in item.json, else auto-glob the item folder.
  const photos = resolvePhotos({ photos: raw.photos, photoDir: dir });
  return ListingSchema.parse({ ...raw, photos });
}

function listSubfolders(dir: string): string[] {
  const root = resolve(dir);
  return readdirSync(root)
    .map((d) => join(root, d))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "item.json")))
    .sort();
}

/** Gentle, human-like spacing between bulk drafts to stay under anti-bot radar. */
function jitterMs(): number {
  const base = Number(process.env.VINTED_BULK_DELAY_MS || 20000);
  return base + Math.floor(Math.random() * base * 0.5);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const headed = process.env.VINTED_HEADED === "1";

  switch (cmd) {
    case "login": {
      const client = new VintedClient({ headed: true });
      const ok = await client.login();
      console.log(ok ? "✅ Logged in and session saved." : "❌ Login not detected before timeout.");
      await client.close();
      break;
    }
    case "check": {
      const client = new VintedClient();
      const ok = await client.isLoggedIn();
      console.log(ok ? "✅ Session valid." : "❌ Not logged in — run: bun run vinted:list login");
      await client.close();
      process.exit(ok ? 0 : 1);
    }
    case "draft": {
      if (!arg) throw new Error("Usage: vinted:list draft <folder>");
      const listing = loadListing(arg);
      const client = new VintedClient({ headed });
      const r = await client.createDraft(listing);
      console.log(`\n📦 ${listing.title}\n${r.summary}`);
      for (const f of r.fields) console.log(`   - ${f.field}: ${f.status}${f.detail ? ` (${f.detail})` : ""}`);
      if (r.screenshotPath) console.log(`   🖼  review: ${r.screenshotPath}`);
      if (r.draftUrl) console.log(`   🔗 draft:  ${r.draftUrl}`);
      await client.close();
      break;
    }
    case "draft-all": {
      if (!arg) throw new Error("Usage: vinted:list draft-all <dir>");
      const folders = listSubfolders(arg);
      console.log(`Found ${folders.length} item folder(s).`);
      const client = new VintedClient({ headed });
      for (let i = 0; i < folders.length; i++) {
        const listing = loadListing(folders[i]);
        const r = await client.createDraft(listing);
        console.log(`\n[${i + 1}/${folders.length}] 📦 ${listing.title} — ${r.summary}`);
        if (r.draftUrl) console.log(`   🔗 ${r.draftUrl}`);
        if (i < folders.length - 1) {
          const d = jitterMs();
          console.log(`   …pausing ${Math.round(d / 1000)}s before next item`);
          await sleep(d);
        }
      }
      await client.close();
      break;
    }
    case "drafts": {
      const client = new VintedClient();
      const drafts = await client.listDrafts();
      console.log(`${drafts.length} draft(s):`);
      for (const d of drafts) console.log(`   - ${d.title}\n     ${d.url}`);
      await client.close();
      break;
    }
    case "publish": {
      if (!arg) throw new Error("Usage: vinted:list publish <draftUrl>");
      const client = new VintedClient({ headed });
      const r = await client.publishDraft(arg);
      console.log(r.published ? `✅ Published: ${r.url}` : `❌ ${r.detail}`);
      await client.close();
      break;
    }
    default:
      console.log(
        "Commands: login | check | draft <folder> | draft-all <dir> | drafts | publish <url>"
      );
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
