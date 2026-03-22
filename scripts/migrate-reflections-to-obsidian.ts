#!/usr/bin/env bun
/**
 * Migrate reflections from Convex to Obsidian vault.
 * Exports all reflections as individual markdown files in obsidian/Reflections/.
 *
 * Usage: bun run scripts/migrate-reflections-to-obsidian.ts
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { loadEnv } from "../src/lib/env";

const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();
await loadEnv(join(PROJECT_ROOT, ".env"));

const OBSIDIAN_DIR = join(PROJECT_ROOT, "obsidian", "Reflections");
if (!existsSync(OBSIDIAN_DIR)) mkdirSync(OBSIDIAN_DIR, { recursive: true });

const { getConvex } = await import("../src/lib/convex");
const { anyApi } = await import("convex/server");
const client = getConvex();

if (!client) {
  console.error("No Convex client available. Set CONVEX_URL in .env");
  process.exit(1);
}

// Fetch all reflections (get a large batch)
const reflections = await client.query(anyApi.reflections.getRecent, { limit: 1000 });

if (!reflections || reflections.length === 0) {
  console.log("No reflections found in Convex.");
  process.exit(0);
}

console.log(`Found ${reflections.length} reflections in Convex.`);

let written = 0;
let skipped = 0;

for (const r of reflections) {
  const filePath = join(OBSIDIAN_DIR, `${r.date}.md`);

  if (existsSync(filePath)) {
    skipped++;
    continue;
  }

  const content = [
    `# Reflection — ${r.date}`,
    "",
    `**Themes:** ${r.themes?.join(", ") || "none"}`,
    "",
    r.content,
    "",
    "## Carry Forward",
    "",
    r.carryForward || "No items to carry forward.",
    "",
    "---",
    `_Generated at ${r.metadata?.generatedAt || new Date(r.createdAt).toISOString()}_`,
  ].join("\n");

  writeFileSync(filePath, content);
  written++;
}

console.log(`Migration complete: ${written} written, ${skipped} already existed.`);
