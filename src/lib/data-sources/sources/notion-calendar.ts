/**
 * Notion Calendar Data Source
 *
 * Fetches today's events from a Notion calendar database.
 * Uses Notion REST API directly — no MCP needed.
 *
 * Required env vars: NOTION_TOKEN, NOTION_CALENDAR_DB
 * Schema: Event (title), Date (date), Type (select), Status (status),
 *         Priority (select), Location (rich_text), Notes (rich_text),
 *         Attendees (people), Reminder (date)
 */

import { register } from "../registry";
import type { DataSource, DataSourceResult } from "../types";

const notionCalendarSource: DataSource = {
  id: "notion-calendar",
  name: "Notion Calendar",
  emoji: "📅",

  isAvailable(): boolean {
    return !!(process.env.NOTION_TOKEN && process.env.NOTION_CALENDAR_DB);
  },

  async fetch(): Promise<DataSourceResult> {
    const token = process.env.NOTION_TOKEN!;
    const databaseId = process.env.NOTION_CALENDAR_DB!;
    const today = new Date().toISOString().split("T")[0];

    // Get today's and upcoming events (next 7 days)
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 7);
    const weekEnd = endDate.toISOString().split("T")[0];

    const response = await fetch(
      `https://api.notion.com/v1/databases/${databaseId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filter: {
            and: [
              {
                property: "Date",
                date: { on_or_after: today },
              },
              {
                property: "Date",
                date: { on_or_before: weekEnd },
              },
              {
                property: "Status",
                status: { does_not_equal: "Cancelled" },
              },
            ],
          },
          sorts: [{ property: "Date", direction: "ascending" }],
          page_size: 20,
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Notion Calendar API error (${response.status}): ${text}`);
    }

    const data = await response.json();
    const pages = data.results || [];

    if (pages.length === 0) {
      return { lines: ["No events this week"], meta: { count: 0, todayCount: 0 } };
    }

    // Split into today and upcoming
    const todayEvents = pages.filter((p: any) => {
      const start = p.properties?.Date?.date?.start || "";
      return start.startsWith(today);
    });

    const upcomingEvents = pages.filter((p: any) => {
      const start = p.properties?.Date?.date?.start || "";
      return !start.startsWith(today);
    });

    const lines: string[] = [];

    if (todayEvents.length > 0) {
      lines.push("**Today:**");
      for (const page of todayEvents) {
        lines.push(formatEvent(page, today));
      }
    } else {
      lines.push("No events today");
    }

    if (upcomingEvents.length > 0) {
      lines.push("");
      lines.push("**Coming up:**");
      for (const page of upcomingEvents.slice(0, 5)) {
        lines.push(formatEvent(page, today));
      }
    }

    return {
      lines,
      meta: {
        count: pages.length,
        todayCount: todayEvents.length,
        upcomingCount: upcomingEvents.length,
      },
    };
  },
};

function formatEvent(page: any, today: string): string {
  const props = page.properties;

  // Title
  const title = extractTitle(page);

  // Date + time
  const dateObj = props.Date?.date;
  const start = dateObj?.start || "";
  const end = dateObj?.end || "";

  let timeStr = "";
  if (start.includes("T")) {
    // Has time component
    const time = new Date(start).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: process.env.USER_TIMEZONE || "Europe/London",
    });
    timeStr = time;
    if (end && end.includes("T")) {
      const endTime = new Date(end).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: process.env.USER_TIMEZONE || "Europe/London",
      });
      timeStr += `–${endTime}`;
    }
  } else {
    // All-day event
    if (!start.startsWith(today)) {
      // Show date for upcoming events
      const d = new Date(start);
      timeStr = d.toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
      });
    } else {
      timeStr = "All day";
    }
  }

  // Type
  const type = props.Type?.select?.name || "";
  const typeEmoji: Record<string, string> = {
    Meeting: "🤝",
    Appointment: "📌",
    Deadline: "⏰",
    Birthday: "🎂",
    Holiday: "🏖️",
    Personal: "👤",
    Work: "💼",
    Reminder: "🔔",
    Event: "🎪",
  };
  const emoji = typeEmoji[type] || "📅";

  // Status
  const status = props.Status?.status?.name || "";
  const statusTag = status === "Tentative" ? " *(tentative)*" : "";

  // Location
  const location = props.Location?.rich_text?.[0]?.plain_text || "";
  const locationStr = location ? ` — ${location}` : "";

  // Priority
  const priority = props.Priority?.select?.name || "";
  const priorityTag = priority === "High" ? " 🔴" : "";

  return `• ${emoji} **${timeStr}** ${title}${locationStr}${statusTag}${priorityTag}`;
}

function extractTitle(page: any): string {
  const props = page.properties || {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop.type === "title" && prop.title?.length > 0) {
      return prop.title.map((t: any) => t.plain_text).join("");
    }
  }
  return "(untitled)";
}

register(notionCalendarSource);
