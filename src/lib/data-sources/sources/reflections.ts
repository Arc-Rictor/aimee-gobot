/**
 * Reflections Data Source
 *
 * Surfaces yesterday's carryForward items in the morning briefing.
 * Reads from Obsidian vault (obsidian/Reflections/).
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { register } from "../registry";
import type { DataSource, DataSourceResult } from "../types";

const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();

const reflectionsSource: DataSource = {
  id: "reflections",
  name: "Yesterday's Reflection",
  emoji: "\uD83E\uDE9E",

  isAvailable(): boolean {
    return existsSync(join(PROJECT_ROOT, "obsidian", "Reflections"));
  },

  async fetch(): Promise<DataSourceResult> {
    try {
      const tz = process.env.USER_TIMEZONE || "UTC";
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toLocaleDateString("en-CA", { timeZone: tz });

      const filePath = join(PROJECT_ROOT, "obsidian", "Reflections", `${yesterdayStr}.md`);
      if (!existsSync(filePath)) return { lines: [], meta: { count: 0 } };

      const content = readFileSync(filePath, "utf-8");

      // Extract carry forward section
      const cfMatch = content.match(/## Carry Forward\n\n([\s\S]*?)(\n---|\n#|$)/);
      if (!cfMatch || !cfMatch[1].trim()) return { lines: [], meta: { count: 0 } };

      const carryForward = cfMatch[1].trim();
      const lines = carryForward
        .split("\n")
        .map((l: string) => l.trim())
        .filter((l: string) => l.length > 0);

      // Extract themes from the file
      const themesMatch = content.match(/\*\*Themes:\*\* (.+)/);
      const themes = themesMatch ? themesMatch[1].split(", ") : [];

      return {
        lines,
        meta: {
          count: lines.length,
          date: yesterdayStr,
          themes,
        },
      };
    } catch {
      return { lines: [], meta: { count: 0 } };
    }
  },
};

register(reflectionsSource);
