/**
 * Reflections Data Source
 *
 * Surfaces yesterday's carryForward items in the morning briefing.
 * Requires: CONVEX_URL (always available when Convex is configured)
 */

import { register } from "../registry";
import type { DataSource, DataSourceResult } from "../types";

const reflectionsSource: DataSource = {
  id: "reflections",
  name: "Yesterday's Reflection",
  emoji: "\uD83E\uDE9E",

  isAvailable(): boolean {
    return !!process.env.CONVEX_URL;
  },

  async fetch(): Promise<DataSourceResult> {
    try {
      const { getConvex } = await import("../../convex");
      const { anyApi } = await import("convex/server");
      const client = getConvex();
      if (!client) return { lines: [], meta: { count: 0 } };

      // Get yesterday's date
      const tz = process.env.USER_TIMEZONE || "UTC";
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toLocaleDateString("en-CA", { timeZone: tz });

      const reflection = await client.query(anyApi.reflections.getByDate, {
        date: yesterdayStr,
      });

      if (!reflection || !reflection.carryForward) {
        return { lines: [], meta: { count: 0 } };
      }

      const lines = reflection.carryForward
        .split("\n")
        .map((l: string) => l.trim())
        .filter((l: string) => l.length > 0);

      return {
        lines,
        meta: {
          count: lines.length,
          date: yesterdayStr,
          themes: reflection.themes,
        },
      };
    } catch {
      return { lines: [], meta: { count: 0 } };
    }
  },
};

register(reflectionsSource);
