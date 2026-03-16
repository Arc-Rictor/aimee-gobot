#!/usr/bin/env bun
/**
 * Go - Discord Morning Briefing
 *
 * Sends a daily briefing to #daily-briefing channel via Discord REST API.
 * Pulls data from available sources (goals, email, etc.) and includes
 * any pending proposals from the bot.
 *
 * Designed to run via cron at the user's preferred morning time.
 *
 * Usage: bun run briefing:discord
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { loadEnv } from "./lib/env";

const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();
await loadEnv(join(PROJECT_ROOT, ".env"));

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const USER_TIMEZONE = process.env.USER_TIMEZONE || "UTC";
const USER_NAME = process.env.USER_NAME || "there";
const LOGS_DIR = join(PROJECT_ROOT, "logs");
const STATE_FILE = join(PROJECT_ROOT, "briefing-state.json");
const PROPOSALS_FILE = join(PROJECT_ROOT, "config/pending-proposal.json");

if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

function log(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Discord REST API
// ---------------------------------------------------------------------------

async function sendDiscordMessage(channelId: string, content: string): Promise<boolean> {
  if (!DISCORD_BOT_TOKEN || !channelId) return false;
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function findChannelByName(name: string): Promise<string | null> {
  if (!DISCORD_BOT_TOKEN) return null;
  try {
    const guildsRes = await fetch("https://discord.com/api/v10/users/@me/guilds", {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
    });
    if (!guildsRes.ok) return null;
    const guilds = (await guildsRes.json()) as any[];

    for (const guild of guilds) {
      const chRes = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/channels`, {
        headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
      });
      if (!chRes.ok) continue;
      const channels = (await chRes.json()) as any[];
      const match = channels.find((c: any) => c.name === name && c.type === 0);
      if (match) return match.id;
    }
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Data Gathering
// ---------------------------------------------------------------------------

async function getGoalsSummary(): Promise<string> {
  try {
    const { getActiveGoals, formatGoalsList } = await import("./lib/convex");
    const goals = await getActiveGoals();
    if (goals.length === 0) return "No active goals set.";

    const now = new Date();
    const overdue = goals.filter((g) => g.deadline && new Date(g.deadline) < now);
    let text = `**${goals.length} active goal${goals.length !== 1 ? "s" : ""}**\n`;
    text += formatGoalsList(goals);
    if (overdue.length > 0) {
      text += `\n⚠️ ${overdue.length} overdue!`;
    }
    return text;
  } catch (err) {
    log(`Goals fetch error: ${err}`);
    return "Could not fetch goals.";
  }
}

async function getFactsSummary(): Promise<string> {
  try {
    const { getFacts, formatFactsList } = await import("./lib/convex");
    const facts = await getFacts();
    if (facts.length === 0) return "";
    return `${facts.length} stored fact${facts.length !== 1 ? "s" : ""} in memory`;
  } catch {
    return "";
  }
}

async function getEmailSummary(): Promise<string> {
  try {
    const { isEmailEnabled, listEmails } = await import("./lib/email");
    if (!isEmailEnabled()) return "";
    const emails = await listEmails(5);
    if (!emails || emails.length === 0) return "📧 No recent emails";
    const unread = emails.filter((e: any) => !e.is_read);
    return `📧 **Email**: ${unread.length} unread, ${emails.length} recent`;
  } catch {
    return "";
  }
}

async function getStaleTasks(): Promise<string> {
  try {
    const { getStaleTasks: getStale } = await import("./lib/convex");
    const stale = await getStale(2 * 60 * 60 * 1000);
    if (stale.length === 0) return "";
    return `⏳ **${stale.length} task${stale.length !== 1 ? "s" : ""} awaiting your input**`;
  } catch {
    return "";
  }
}

function getProposal(): string | null {
  try {
    if (!existsSync(PROPOSALS_FILE)) return null;
    const data = JSON.parse(readFileSync(PROPOSALS_FILE, "utf-8"));
    if (data.delivered) return null; // Already shown
    return data.content || null;
  } catch {
    return null;
  }
}

function markProposalDelivered() {
  try {
    if (!existsSync(PROPOSALS_FILE)) return;
    const data = JSON.parse(readFileSync(PROPOSALS_FILE, "utf-8"));
    data.delivered = true;
    writeFileSync(PROPOSALS_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

// ---------------------------------------------------------------------------
// Build Briefing
// ---------------------------------------------------------------------------

async function buildBriefing(): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-GB", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const timeStr = now.toLocaleTimeString("en-GB", {
    timeZone: USER_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
  });

  // Gather all sections in parallel
  const [goals, facts, email, stale] = await Promise.all([
    getGoalsSummary(),
    getFactsSummary(),
    getEmailSummary(),
    getStaleTasks(),
  ]);

  const proposal = getProposal();

  // Build the briefing
  let briefing = `☀️ **GOOD MORNING ${USER_NAME.toUpperCase()}**\n`;
  briefing += `_${dateStr} • ${timeStr}_\n\n`;

  briefing += `🎯 **GOALS**\n${goals}\n\n`;

  if (email) briefing += `${email}\n\n`;
  if (stale) briefing += `${stale}\n\n`;
  if (facts) briefing += `🧠 **Memory**: ${facts}\n\n`;

  // Include any pending proposal
  if (proposal) {
    briefing += `---\n\n`;
    briefing += `💡 **PROPOSAL FROM AIMEE**\n\n`;
    briefing += proposal;
    briefing += `\n\n_Reply here to approve, modify, or reject._`;
    markProposalDelivered();
  }

  briefing += `\n\n---\n_Your AI assistant is online and ready._`;

  return briefing;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Dedup: skip if briefing was already sent today
  try {
    if (existsSync(STATE_FILE)) {
      const state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
      const today = new Date().toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });
      if (state.lastBriefingDate === today) {
        log(`Briefing already sent today (${today}), skipping.`);
        return;
      }
    }
  } catch {}

  // Time-window guard: only send between 7:00 AM and 12:00 PM local time
  // Wide window so cron delays don't prevent delivery. Dedup guard above prevents doubles.
  const nowLocal = new Date().toLocaleTimeString("en-GB", {
    timeZone: USER_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const [hh, mm] = nowLocal.split(":").map(Number);
  const minutesSinceMidnight = hh * 60 + mm;
  const WINDOW_START = 7 * 60;      // 07:00
  const WINDOW_END = 12 * 60;       // 12:00
  if (minutesSinceMidnight < WINDOW_START || minutesSinceMidnight > WINDOW_END) {
    log(`Outside briefing window (${nowLocal}). Briefings only send between 07:00–12:00. Skipping.`);
    return;
  }

  log("Building morning briefing...");

  const channelId = await findChannelByName("daily-briefing");
  if (!channelId) {
    log("ERROR: Could not find #daily-briefing channel");
    return;
  }
  log(`Found #daily-briefing channel: ${channelId}`);

  const briefing = await buildBriefing();

  // Discord has a 2000 char limit — split if needed
  const chunks: string[] = [];
  if (briefing.length <= 2000) {
    chunks.push(briefing);
  } else {
    // Simple split on double newlines
    let remaining = briefing;
    while (remaining.length > 0) {
      if (remaining.length <= 2000) {
        chunks.push(remaining);
        break;
      }
      let idx = remaining.lastIndexOf("\n\n", 2000);
      if (idx < 500) idx = 2000;
      chunks.push(remaining.slice(0, idx));
      remaining = remaining.slice(idx).trim();
    }
  }

  for (const chunk of chunks) {
    const sent = await sendDiscordMessage(channelId, chunk);
    if (!sent) {
      log("Failed to send briefing chunk");
      return;
    }
  }

  log("Briefing sent to Discord successfully!");

  // Record that briefing was sent today
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });
    writeFileSync(STATE_FILE, JSON.stringify({ lastBriefingDate: today }, null, 2));
  } catch {}
}

main().catch((err) => log(`Briefing error: ${err}`));
