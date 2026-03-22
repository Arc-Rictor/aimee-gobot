#!/usr/bin/env bun
/**
 * Go - Discord Overnight Worker
 *
 * Picks up tasks tagged with [OVERNIGHT:] and works on them autonomously.
 * Uses Claude subprocess for research and reasoning, posts progress to #logs,
 * and delivers final results to the originating channel or #daily-briefing.
 *
 * Designed to run via cron every 2 hours overnight.
 *
 * Safety:
 * - Max runtime per task: 10 minutes
 * - No destructive actions (read-only tools + web search)
 * - Posts progress to #logs so user can see what happened
 * - Only processes tasks in "pending" status
 *
 * Usage: bun run overnight
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { loadEnv } from "./lib/env";

const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();
await loadEnv(join(PROJECT_ROOT, ".env"));

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const LOGS_DIR = join(PROJECT_ROOT, "logs");
const OVERNIGHT_STATE = join(PROJECT_ROOT, "overnight-state.json");

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
    // Split long messages
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
// Overnight Task Storage (file-based, simple)
// ---------------------------------------------------------------------------

export interface OvernightTask {
  id: string;
  task: string;
  status: "pending" | "running" | "completed" | "failed";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  deliverTo?: string; // channel name to deliver results to
  progress: string[];  // progress log entries
}

function loadTasks(): OvernightTask[] {
  try {
    if (!existsSync(OVERNIGHT_STATE)) return [];
    const data = JSON.parse(readFileSync(OVERNIGHT_STATE, "utf-8"));
    return data.tasks || [];
  } catch {
    return [];
  }
}

function saveTasks(tasks: OvernightTask[]) {
  const tmpPath = OVERNIGHT_STATE + ".tmp";
  writeFileSync(tmpPath, JSON.stringify({ tasks }, null, 2));
  renameSync(tmpPath, OVERNIGHT_STATE);
}

export function addOvernightTask(task: string, deliverTo?: string): OvernightTask {
  const tasks = loadTasks();
  const newTask: OvernightTask = {
    id: `ovn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    task,
    status: "pending",
    createdAt: new Date().toISOString(),
    deliverTo: deliverTo || "daily-briefing",
    progress: [],
  };
  tasks.push(newTask);
  saveTasks(tasks);
  return newTask;
}

function updateTask(id: string, updates: Partial<OvernightTask>) {
  const tasks = loadTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx >= 0) {
    tasks[idx] = { ...tasks[idx], ...updates };
    saveTasks(tasks);
  }
}

// ---------------------------------------------------------------------------
// Claude Subprocess (lightweight — research-only tools)
// ---------------------------------------------------------------------------

async function runClaudeResearch(prompt: string): Promise<string> {
  const { callClaude } = await import("./lib/claude");

  const result = await callClaude({
    prompt,
    outputFormat: "json",
    allowedTools: ["WebSearch", "WebFetch", "Read"],
    timeoutMs: 600_000, // 10 min max
    cwd: PROJECT_ROOT,
    maxTurns: "15",
  });

  if (result.isError || !result.text) {
    throw new Error("Claude subprocess failed or returned empty");
  }

  return result.text;
}

// ---------------------------------------------------------------------------
// Process a Single Task
// ---------------------------------------------------------------------------

async function processTask(task: OvernightTask, logsChannelId: string | null): Promise<void> {
  log(`Processing task: ${task.id} — "${task.task.substring(0, 80)}..."`);

  updateTask(task.id, {
    status: "running",
    startedAt: new Date().toISOString(),
  });

  // Post to #logs that we're starting
  if (logsChannelId) {
    await sendDiscordMessage(
      logsChannelId,
      `**Overnight Worker** — Starting task:\n> ${task.task}\n_Task ID: ${task.id}_`
    );
  }

  try {
    const researchPrompt = `You are an autonomous research assistant working overnight. The user is asleep and will review your output in the morning.

## YOUR TASK
${task.task}

## INSTRUCTIONS
- Be thorough but concise. The user wants actionable results, not filler.
- Use web search to find current information.
- Structure your output clearly with headers and bullet points.
- Include sources/URLs where relevant.
- If the task involves analysis, provide clear recommendations.
- If the task is ambiguous, interpret it reasonably and note your assumptions.
- Format for Discord (markdown, max ~3000 chars for readability).

## OUTPUT FORMAT
Deliver a polished, ready-to-read report. Start with a one-line summary, then details.`;

    const result = await runClaudeResearch(researchPrompt);

    updateTask(task.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      result,
      progress: [...task.progress, "Completed successfully"],
    });

    // Post completion to #logs
    if (logsChannelId) {
      await sendDiscordMessage(
        logsChannelId,
        `**Overnight Worker** — Task completed: ${task.id}\n_Delivering to #${task.deliverTo}_`
      );
    }

    // Deliver result to target channel
    const targetChannel = await findChannelByName(task.deliverTo || "daily-briefing");
    if (targetChannel) {
      const delivery = `**Overnight Task Complete**\n> ${task.task}\n\n${result}`;
      await sendDiscordMessage(targetChannel, delivery);
    }

    log(`Task ${task.id} completed and delivered`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Task ${task.id} failed: ${errorMsg}`);

    updateTask(task.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      progress: [...task.progress, `Failed: ${errorMsg}`],
    });

    if (logsChannelId) {
      await sendDiscordMessage(
        logsChannelId,
        `**Overnight Worker** — Task failed: ${task.id}\nError: ${errorMsg}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("--- Overnight Worker starting ---");

  const tasks = loadTasks();
  const pending = tasks.filter((t) => t.status === "pending");

  if (pending.length === 0) {
    log("No pending tasks. Nothing to do.");
    return;
  }

  log(`Found ${pending.length} pending task(s)`);

  const logsChannelId = await findChannelByName("logs");

  // Process tasks sequentially (one at a time to be safe)
  for (const task of pending) {
    await processTask(task, logsChannelId);
  }

  log("--- Overnight Worker complete ---");
}

// Only run main() when executed directly (not when imported by discord-bot.ts)
const isDirectRun = import.meta.url === Bun.main || process.argv[1]?.endsWith("discord-overnight.ts");
if (isDirectRun) {
  main().catch((err) => log(`Overnight worker error: ${err}`));
}
