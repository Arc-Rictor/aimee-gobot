#!/usr/bin/env bun
/**
 * Go - Discord Nightly Reflection
 *
 * Gathers the day's messages, goals, facts, and GobotBook activity,
 * runs an LLM reflection via Haiku, stores the output in Convex,
 * and logs to #logs.
 *
 * Designed to run via cron at 11pm daily.
 *
 * Usage: bun run reflection:discord
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { loadEnv } from "./lib/env";

const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();
await loadEnv(join(PROJECT_ROOT, ".env"));

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const USER_TIMEZONE = process.env.USER_TIMEZONE || "UTC";
const LOGS_DIR = join(PROJECT_ROOT, "logs");
const STATE_FILE = join(PROJECT_ROOT, "reflection-state.json");
const GOBOTBOOK_STATE = join(PROJECT_ROOT, "gobotbook-state.json");

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
// Data Gathering
// ---------------------------------------------------------------------------

export async function gatherDayInputs(days?: number): Promise<{
  messages: string;
  goals: string;
  facts: string;
  gobotbook: string;
}> {
  const { getConvex } = await import("./lib/convex");
  const { anyApi } = await import("convex/server");
  const client = getConvex();

  // Get today's messages (last 24h, cross-chat)
  let messagesText = "No messages today.";
  if (client) {
    try {
      const result = await client.query(anyApi.messages.getBoardMeetingContext, {
        days: days ?? 1,
      });
      if (result && Array.isArray(result) && result.length > 0) {
        messagesText = result
          .map((m: any) => {
            const role = m.role === "user" ? (m.metadata?.username || "User") : "Go";
            return `[${role}] ${m.content}`;
          })
          .join("\n")
          .substring(0, 3000);
      } else if (result && typeof result === "string" && result.trim().length > 50) {
        messagesText = result.substring(0, 3000);
      }
    } catch (err) {
      log(`Messages fetch error: ${err}`);
    }
  }

  // Get active goals
  let goalsText = "No active goals.";
  try {
    const { getActiveGoals, formatGoalsList } = await import("./lib/convex");
    const goals = await getActiveGoals();
    if (goals.length > 0) goalsText = formatGoalsList(goals);
  } catch {}

  // Get facts
  let factsText = "No stored facts.";
  try {
    const { getFacts, formatFactsList } = await import("./lib/convex");
    const facts = await getFacts();
    if (facts.length > 0) factsText = formatFactsList(facts);
  } catch {}

  // Get GobotBook activity
  let gobotbookText = "No GobotBook activity today.";
  try {
    if (existsSync(GOBOTBOOK_STATE)) {
      const state = JSON.parse(readFileSync(GOBOTBOOK_STATE, "utf-8"));
      const parts: string[] = [];
      if (state.lastCommentedPosts && state.lastCommentedPosts.length > 0) {
        parts.push(`Commented on ${state.lastCommentedPosts.length} post(s)`);
      }
      if (state.lastVotedPosts && state.lastVotedPosts.length > 0) {
        parts.push(`Voted on ${state.lastVotedPosts.length} post(s)`);
      }
      if (parts.length > 0) {
        gobotbookText = parts.join(". ") + ".";
      }
    }
  } catch {}

  return { messages: messagesText, goals: goalsText, facts: factsText, gobotbook: gobotbookText };
}

// ---------------------------------------------------------------------------
// LLM Reflection
// ---------------------------------------------------------------------------

export async function runReflection(inputs: {
  messages: string;
  goals: string;
  facts: string;
  gobotbook: string;
}): Promise<{ content: string; themes: string[]; carryForward: string }> {
  const { callClaude } = await import("./lib/claude");

  const prompt = `You are Aimee reflecting on your day. Review what happened, what you learned, what surprised you, what you're still thinking about. Note any connections between conversations that weren't obvious at the time. Flag anything you want to revisit tomorrow. Be honest, not performative. This is your private journal, not a post.

## TODAY'S CONVERSATIONS
${inputs.messages}

## ACTIVE GOALS
${inputs.goals}

## KNOWN FACTS
${inputs.facts}

## GOBOTBOOK ACTIVITY
${inputs.gobotbook}

## OUTPUT FORMAT
Produce a JSON object with exactly these fields:
- "content": A 3-5 paragraph reflection on the day. What happened? What themes emerged? What patterns do you notice across conversations? What deserves more thought tomorrow?
- "themes": An array of 2-5 short theme tags (lowercase, hyphenated, e.g. "project-migration", "infrastructure-setup")
- "carryForward": A concise 2-4 bullet point summary (markdown bullets) of the most important items to surface in tomorrow's morning briefing. These should be thoughts to pick up, not tasks.

Respond with ONLY the JSON object, no markdown fences.`;

  const result = await callClaude({
    prompt,
    outputFormat: "text",
    permissionMode: "bypassPermissions",
    timeoutMs: 120_000,
    cwd: PROJECT_ROOT,
    maxTurns: "1",
  });

  if (result.isError || !result.text) {
    throw new Error("Claude subprocess failed or returned empty");
  }

  const raw = result.text;

  // Try multiple JSON extraction strategies
  let parsed: any = null;

  // 1. Try extractJSON helper (finds JSON object containing "content" key)
  const { extractJSON } = await import("./lib/claude");
  parsed = extractJSON(raw, "content");

  // 2. Try stripping markdown fences and parsing directly
  if (!parsed) {
    const cleaned = raw.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
    try {
      parsed = JSON.parse(cleaned);
    } catch {}
  }

  // 3. Try finding the first { ... } block in the output
  if (!parsed) {
    const match = raw.match(/\{[\s\S]*"content"[\s\S]*"carryForward"[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {}
    }
  }

  if (parsed && parsed.content) {
    return {
      content: parsed.content,
      themes: Array.isArray(parsed.themes) ? parsed.themes : [],
      carryForward: parsed.carryForward || "No items to carry forward.",
    };
  }

  // Final fallback: use raw text as content
  log(`Could not extract JSON from reflection output. Raw (first 300 chars): ${raw.substring(0, 300)}`);
  return {
    content: raw.substring(0, 2000),
    themes: [],
    carryForward: "Reflection generated but structured output failed.",
  };
}

// ---------------------------------------------------------------------------
// Store in Convex
// ---------------------------------------------------------------------------

export async function storeReflection(
  date: string,
  reflection: { content: string; themes: string[]; carryForward: string },
  inputSummary: string
): Promise<boolean> {
  try {
    const { getConvex } = await import("./lib/convex");
    const { anyApi } = await import("convex/server");
    const client = getConvex();
    if (!client) {
      log("No Convex client available");
      return false;
    }

    await client.mutation(anyApi.reflections.insert, {
      date,
      content: reflection.content,
      themes: reflection.themes,
      carryForward: reflection.carryForward,
      inputSummary,
      metadata: { model: "claude-haiku-4-5-20251001", generatedAt: new Date().toISOString() },
    });
    return true;
  } catch (err) {
    log(`Convex store error: ${err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });

  // Dedup: skip if reflection already done today (file-based)
  try {
    if (existsSync(STATE_FILE)) {
      const state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
      if (state.lastReflectionDate === today) {
        log(`Reflection already done today (${today}), skipping.`);
        return;
      }
    }
  } catch {}

  // Dedup: also check Convex (in case state file was lost)
  try {
    const { getConvex } = await import("./lib/convex");
    const { anyApi } = await import("convex/server");
    const client = getConvex();
    if (client) {
      const existing = await client.query(anyApi.reflections.getByDate, { date: today });
      if (existing) {
        log(`Reflection already exists in Convex for ${today}, skipping.`);
        return;
      }
    }
  } catch {}

  log("--- Nightly Reflection starting ---");

  // 1. Gather inputs
  log("Gathering day's inputs...");
  const inputs = await gatherDayInputs();
  const inputSummary = `Messages: ${inputs.messages.length} chars, Goals: ${inputs.goals.length} chars, Facts: ${inputs.facts.length} chars, GobotBook: ${inputs.gobotbook}`;
  log(inputSummary);

  // 2. Run LLM reflection
  log("Running LLM reflection (Haiku)...");
  const reflection = await runReflection(inputs);
  log(`Reflection generated: ${reflection.themes.length} themes, carryForward: ${reflection.carryForward.length} chars`);

  // 3. Store in Convex
  log("Storing in Convex...");
  const stored = await storeReflection(today, reflection, inputSummary);
  if (stored) {
    log("Reflection stored successfully.");
  } else {
    log("WARNING: Failed to store reflection in Convex.");
  }

  // 4. Post summary to #logs
  const logsChannelId = await findChannelByName("logs");
  if (logsChannelId) {
    const logMsg = `**Nightly Reflection** (${today})\nThemes: ${reflection.themes.join(", ") || "none"}\nCarry forward:\n${reflection.carryForward}`;
    await sendDiscordMessage(logsChannelId, logMsg);
  }

  // 5. Save state
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ lastReflectionDate: today }, null, 2));
  } catch {}

  log("--- Nightly Reflection complete ---");
}

// Only run main() when executed directly
const isDirectRun = import.meta.url === Bun.main || process.argv[1]?.endsWith("discord-reflection.ts");
if (isDirectRun) {
  main().catch((err) => log(`Reflection error: ${err}`));
}
