#!/usr/bin/env bun
/**
 * Go - Weekly Strategic Digest
 *
 * Runs Sunday night, researches AI landscape topics relevant to Simon's role,
 * and delivers a curated intelligence brief on Monday 9am via:
 * - Email to work address (simonhodgkinson@redcross.org.uk)
 * - Discord #daily-briefing channel
 *
 * Topics:
 * 1. AI Policy & Regulation (UK gov, charity sector, NHS/public sector)
 * 2. Humanitarian AI (Red Cross/Red Crescent, NGOs)
 * 3. Tools & Frameworks (agent frameworks, governance, responsible AI)
 * 4. One Actionable Insight tied to current strategy work
 *
 * Usage: bun run digest
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { loadEnv } from "./lib/env";

const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();
await loadEnv(join(PROJECT_ROOT, ".env"));

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const USER_TIMEZONE = process.env.USER_TIMEZONE || "Europe/London";
const DIGEST_EMAIL = process.env.DIGEST_EMAIL || process.env.BRIEFING_EMAIL || "";
const LOGS_DIR = join(PROJECT_ROOT, "logs");
const STATE_FILE = join(PROJECT_ROOT, "digest-state.json");

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
    const chunks: string[] = [];
    if (content.length <= 2000) {
      chunks.push(content);
    } else {
      let remaining = content;
      while (remaining.length > 0) {
        if (remaining.length <= 2000) { chunks.push(remaining); break; }
        let idx = remaining.lastIndexOf("\n\n", 2000);
        if (idx < 500) idx = remaining.lastIndexOf("\n", 2000);
        if (idx < 500) idx = 2000;
        chunks.push(remaining.slice(0, idx));
        remaining = remaining.slice(idx).trim();
      }
    }
    for (const chunk of chunks) {
      const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: chunk }),
      });
      if (!res.ok) return false;
    }
    return true;
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
// Research via Claude
// ---------------------------------------------------------------------------

async function runClaudeResearch(prompt: string): Promise<string> {
  const { callClaude } = await import("./lib/claude");
  const result = await callClaude({
    prompt,
    outputFormat: "json",
    allowedTools: ["WebSearch", "WebFetch", "Read"],
    timeoutMs: 600_000,
    cwd: PROJECT_ROOT,
    maxTurns: "20",
  });
  if (result.isError || !result.text) {
    throw new Error("Claude subprocess failed or returned empty");
  }
  return result.text;
}

// ---------------------------------------------------------------------------
// Build Digest
// ---------------------------------------------------------------------------

async function buildDigest(): Promise<string> {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - 7);
  const dateRange = `${weekStart.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${now.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;

  const prompt = `You are an AI intelligence analyst preparing a weekly strategic digest for Simon Hodgkinson, Head of AI at the British Red Cross.

## YOUR TASK
Research the past week's developments across these categories and compile a concise, actionable digest.

## CATEGORIES TO RESEARCH

1. **AI Policy & Regulation** — Search for: UK government AI guidance this week, charity sector AI policies, NHS digital/AI announcements, EU AI Act implementation updates, UK AI Safety Institute news
2. **Humanitarian AI** — Search for: Red Cross Red Crescent AI projects, ICRC technology initiatives, NGO AI deployments, humanitarian tech news this week
3. **Tools & Frameworks** — Search for: new AI agent frameworks released this week, responsible AI toolkits, AI governance tools, enterprise AI platforms updates relevant to a team building an AI Hub
4. **One Actionable Insight** — Based on everything you found, give ONE specific recommendation that Simon should consider for his AI strategy at British Red Cross

## FORMAT REQUIREMENTS
- Use Discord markdown (bold with **, headers with ##)
- Keep the total digest under 1500 characters (concise!)
- Each section: 2-3 bullet points max, with source names
- The actionable insight should be a clear, specific recommendation
- Start with: "📊 **WEEKLY STRATEGIC DIGEST**"
- End with: "---\\n_Week of ${dateRange}_"
- If you find nothing notable in a category, say "No major developments this week" in one line

## IMPORTANT
- Only include genuinely recent news (last 7 days)
- Prioritise UK and humanitarian sector relevance
- Be specific — names, dates, organisations — not vague summaries`;

  log("Running Claude research for weekly digest...");
  const digest = await runClaudeResearch(prompt);
  return digest;
}

// ---------------------------------------------------------------------------
// Deliver
// ---------------------------------------------------------------------------

async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  const { sendEmail: send, isEmailEnabled } = await import("./lib/email");
  if (!isEmailEnabled()) {
    log("Email not enabled — skipping email delivery");
    return;
  }
  await send({ to, subject, text: body });
  log(`Digest emailed to ${to}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Dedup: only send once per week (keyed by ISO week number)
  const now = new Date();
  const yearWeek = `${now.getFullYear()}-W${String(Math.ceil(((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 86400000 + new Date(now.getFullYear(), 0, 1).getDay() + 1) / 7)).padStart(2, "0")}`;

  try {
    if (existsSync(STATE_FILE)) {
      const state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
      if (state.lastDigestWeek === yearWeek) {
        log(`Digest already sent for ${yearWeek}, skipping.`);
        return;
      }
    }
  } catch {}

  log(`Building weekly digest for ${yearWeek}...`);

  const digest = await buildDigest();

  // 1. Send to Discord #daily-briefing
  const channelId = await findChannelByName("daily-briefing");
  if (channelId) {
    const sent = await sendDiscordMessage(channelId, digest);
    if (sent) log("Digest posted to Discord #daily-briefing");
    else log("Failed to post digest to Discord");
  }

  // 2. Email to work address
  if (DIGEST_EMAIL) {
    const dateStr = now.toLocaleDateString("en-GB", {
      timeZone: USER_TIMEZONE,
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    // Strip Discord markdown for email
    const emailBody = digest
      .replace(/\*\*/g, "")
      .replace(/_([^_]+)_/g, "$1")
      .replace(/##\s*/g, "");

    try {
      await sendEmail(DIGEST_EMAIL, `Weekly Strategic Digest — ${dateStr}`, emailBody);
    } catch (err) {
      log(`Email delivery failed: ${err}`);
    }
  }

  // Record that digest was sent this week
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ lastDigestWeek: yearWeek }, null, 2));
  } catch {}

  log("Weekly digest complete!");
}

main().catch((err) => log(`Digest error: ${err}`));
