#!/usr/bin/env bun
/**
 * Vinted photo-upload bridge — run on the laptop, open on your phone.
 *
 * Lets you photograph items on your phone and drop them straight into a per-item
 * folder under ./listings on the laptop, over your home network. No app, no
 * cloud — just a web page. From there, Claude (or the CLI) turns the folder into
 * a Vinted draft.
 *
 * Run on the laptop:
 *   bun run vinted:upload
 *
 * Then on your phone (same Wi-Fi) open the http://<laptop-ip>:8787 URL it prints.
 *
 * Env:
 *   VINTED_UPLOAD_PORT   default 8787
 *   VINTED_LISTINGS_DIR  default ./listings
 *   VINTED_UPLOAD_TOKEN  if set, the page requires ?token=... (simple guard)
 */

import { networkInterfaces } from "os";
import { join, resolve, extname } from "path";
import { mkdirSync, readdirSync, existsSync, statSync } from "fs";

const PORT = Number(process.env.VINTED_UPLOAD_PORT || 8787);
const LISTINGS_DIR = resolve(process.env.VINTED_LISTINGS_DIR || "listings");
const TOKEN = process.env.VINTED_UPLOAD_TOKEN || "";
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic"]);

mkdirSync(LISTINGS_DIR, { recursive: true });

function lanIPs(): string[] {
  const out: string[] = [];
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

/** Make a filesystem-safe folder name from a free-text item name. */
function slug(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || `item-${Date.now()}`;
}

function existingFolders(): { name: string; count: number }[] {
  if (!existsSync(LISTINGS_DIR)) return [];
  return readdirSync(LISTINGS_DIR)
    .map((d) => join(LISTINGS_DIR, d))
    .filter((p) => statSync(p).isDirectory())
    .map((p) => ({
      name: p.split(/[\\/]/).pop()!,
      count: readdirSync(p).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase())).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function authOK(url: URL): boolean {
  if (!TOKEN) return true;
  return url.searchParams.get("token") === TOKEN;
}

function page(body: string): Response {
  const html = `<!doctype html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vinted photo upload</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 20px; }
  h1 { font-size: 1.3rem; }
  label { display:block; font-weight:600; margin: 16px 0 6px; }
  input[type=text], textarea { width:100%; padding:12px; font-size:1rem; border:1px solid #888; border-radius:8px; box-sizing:border-box; }
  input[type=file] { width:100%; padding:12px 0; font-size:1rem; }
  button { width:100%; padding:16px; font-size:1.1rem; font-weight:700; border:0; border-radius:10px; background:#09b1ba; color:#fff; margin-top:20px; }
  .hint { color:#888; font-size:.85rem; margin-top:4px; }
  .ok { background:#e8f8ec; border:1px solid #36b37e; padding:14px; border-radius:8px; }
  .folders { margin-top:28px; font-size:.9rem; }
  .folders li { margin:4px 0; }
  code { background:#8881; padding:2px 5px; border-radius:4px; }
</style></head><body>${body}</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function uploadForm(msg = ""): string {
  const tokenField = TOKEN ? `<input type="hidden" name="token" value="${TOKEN}">` : "";
  const folders = existingFolders();
  const folderList = folders.length
    ? `<div class="folders"><strong>Items so far:</strong><ul>${folders
        .map((f) => `<li>${f.name} — ${f.count} photo(s)</li>`)
        .join("")}</ul></div>`
    : "";
  return `
  <h1>📸 Add a Vinted item</h1>
  ${msg}
  <form method="POST" action="/upload${TOKEN ? `?token=${TOKEN}` : ""}" enctype="multipart/form-data">
    ${tokenField}
    <label>Item name</label>
    <input type="text" name="item" placeholder="e.g. nike air max 90 uk9" autocomplete="off">
    <div class="hint">Becomes the folder name. Leave blank for an auto name.</div>

    <label>Notes for Claude (optional)</label>
    <textarea name="notes" rows="3" placeholder="e.g. small mark on left sleeve, RRP £80, smoke-free home"></textarea>

    <label>Photos</label>
    <input type="file" name="photos" accept="image/*" multiple>
    <div class="hint">Tip: take/select them in the order you want shown — the first is the cover.</div>

    <button type="submit">Upload</button>
  </form>
  ${folderList}`;
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  maxRequestBodySize: 1024 * 1024 * 200, // 200MB — plenty for a batch of phone photos
  async fetch(req) {
    const url = new URL(req.url);

    if (!authOK(url)) return new Response("Forbidden — missing/invalid token.", { status: 403 });

    if (req.method === "GET" && url.pathname === "/") {
      return page(uploadForm());
    }

    if (req.method === "POST" && url.pathname === "/upload") {
      const form = await req.formData();
      const item = String(form.get("item") || "").trim();
      const notes = String(form.get("notes") || "").trim();
      const files = form.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);

      if (!files.length) {
        return page(uploadForm(`<div class="ok" style="background:#fdeaea;border-color:#d9534f">No photos selected — try again.</div>`));
      }

      const folderName = slug(item);
      const dir = join(LISTINGS_DIR, folderName);
      mkdirSync(dir, { recursive: true });

      // Preserve selection order; zero-pad an index so they sort correctly.
      let i = readdirSync(dir).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase())).length;
      const saved: string[] = [];
      for (const file of files) {
        i++;
        let ext = extname(file.name).toLowerCase();
        if (!IMAGE_EXT.has(ext)) ext = ".jpg";
        const name = `${String(i).padStart(2, "0")}${ext}`;
        await Bun.write(join(dir, name), file);
        saved.push(name);
      }

      // Drop a starter item.json (Claude/you fill the rest) if none exists yet.
      const jsonPath = join(dir, "item.json");
      if (!existsSync(jsonPath)) {
        await Bun.write(
          jsonPath,
          JSON.stringify(
            { title: item || "", description: "", category: [], condition: "", price: 0, notes, photos: [] },
            null,
            2
          )
        );
      }

      const msg = `<div class="ok">✅ Saved ${saved.length} photo(s) to <code>listings/${folderName}</code>.<br>
        On the laptop, list it with:<br><code>bun run vinted:list draft ./listings/${folderName}</code><br>
        …or just tell Claude: <em>"list the item in listings/${folderName}"</em>.</div>`;
      return page(uploadForm(msg));
    }

    return new Response("Not found", { status: 404 });
  },
});

const ips = lanIPs();
console.log(`\n📸 Vinted photo-upload server running.\n`);
console.log(`   Saving to: ${LISTINGS_DIR}`);
if (TOKEN) console.log(`   Token required (?token=${TOKEN})`);
console.log(`\n   Open on your phone (same Wi-Fi):`);
if (ips.length) {
  for (const ip of ips) console.log(`     → http://${ip}:${server.port}${TOKEN ? `?token=${TOKEN}` : ""}`);
} else {
  console.log(`     → http://<this-laptop-ip>:${server.port}  (couldn't auto-detect the LAN IP)`);
}
console.log(`\n   On the laptop it's at http://localhost:${server.port}\n   Press Ctrl+C to stop.\n`);
