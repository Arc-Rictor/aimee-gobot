#!/usr/bin/env bun
/**
 * Go - Discord Bot Heartbeat
 *
 * Monitors the Discord bot process, restarts if down, and checks for
 * outstanding tasks/goals that need attention.
 *
 * Designed to run via cron (e.g. every 30 minutes).
 *
 * Usage: bun run heartbeat:discord
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { loadEnv } from "./lib/env";

const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();
await loadEnv(join(PROJECT_ROOT, ".env"));

const LOGS_DIR = join(PROJECT_ROOT, "logs");
const HEARTBEAT_LOG = join(LOGS_DIR, "discord-heartbeat.log");
const PID_FILE = join(PROJECT_ROOT, "discord-bot.pid");
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_ALERTS_CHANNEL = process.env.DISCORD_ALERTS_CHANNEL; // channel ID
const DISCORD_GOBOTBOOK_CHANNEL = process.env.DISCORD_GOBOTBOOK_CHANNEL || ""; // GobotBook updates channel

// Ensure logs directory exists
if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

function log(message: string) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  console.log(line.trim());
  try {
    const existing = existsSync(HEARTBEAT_LOG) ? readFileSync(HEARTBEAT_LOG, "utf-8") : "";
    const lines = existing.split("\n").filter(Boolean).slice(-200);
    lines.push(line.trim());
    writeFileSync(HEARTBEAT_LOG, lines.join("\n") + "\n");
  } catch {}
}

// ---------------------------------------------------------------------------
// Discord REST API (no client needed — just HTTP)
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

/** Find the alerts channel ID by searching guild channels via REST. */
async function findAlertsChannel(): Promise<string | null> {
  if (DISCORD_ALERTS_CHANNEL) return DISCORD_ALERTS_CHANNEL;
  if (!DISCORD_BOT_TOKEN) return null;

  try {
    // Get bot's guilds
    const guildsRes = await fetch("https://discord.com/api/v10/users/@me/guilds", {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
    });
    if (!guildsRes.ok) return null;
    const guilds = await guildsRes.json() as any[];

    for (const guild of guilds) {
      const chRes = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/channels`, {
        headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
      });
      if (!chRes.ok) continue;
      const channels = await chRes.json() as any[];
      const alerts = channels.find((c: any) => c.name === "alerts" && c.type === 0);
      if (alerts) return alerts.id;
    }
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Process Health Check
// ---------------------------------------------------------------------------

async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Check if the bot is actually connected to Discord (not just alive as a PID) */
async function isBotHealthy(): Promise<{ alive: boolean; connected: boolean }> {
  const healthFile = join(PROJECT_ROOT, "discord-bot-health.json");
  try {
    if (!existsSync(healthFile)) return { alive: false, connected: false };
    const data = JSON.parse(readFileSync(healthFile, "utf-8"));

    // Check if health file is stale (>2 minutes old = bot isn't updating it)
    const lastHeartbeat = new Date(data.lastHeartbeat || data.startedAt);
    const staleMs = Date.now() - lastHeartbeat.getTime();
    if (staleMs > 2 * 60 * 1000) {
      log(`Health file stale (${Math.round(staleMs / 1000)}s old) — bot is hung`);
      return { alive: true, connected: false };
    }

    return { alive: true, connected: data.connected === true };
  } catch {
    return { alive: false, connected: false };
  }
}

/** Verify bot token works by calling Discord API directly */
async function verifyDiscordToken(): Promise<boolean> {
  if (!DISCORD_BOT_TOKEN) return false;
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function findDiscordBotProcess(): Promise<number | null> {
  if (existsSync(PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
      if (await isProcessRunning(pid)) return pid;
      log("PID file exists but process is dead — will restart");
    } catch {}
  }

  try {
    const pm2Check = Bun.spawnSync(["pm2", "jlist"], { stdout: "pipe", stderr: "pipe" });
    if (pm2Check.exitCode === 0) {
      const list = JSON.parse(pm2Check.stdout.toString());
      const discordProc = list.find((p: any) =>
        p.name === "go-discord" || p.pm2_env?.script?.includes("discord-bot")
      );
      if (discordProc && discordProc.pm2_env?.status === "online") {
        return discordProc.pid;
      }
    }
  } catch {}

  try {
    const ps = Bun.spawnSync(["pgrep", "-f", "discord-bot.ts"], { stdout: "pipe" });
    if (ps.exitCode === 0) {
      const pid = parseInt(ps.stdout.toString().trim().split("\n")[0]);
      if (pid && !isNaN(pid)) return pid;
    }
  } catch {}

  return null;
}

async function startDiscordBot(): Promise<boolean> {
  log("Starting Discord bot...");
  try {
    const pm2Check = Bun.spawnSync(["which", "pm2"], { stdout: "pipe" });
    if (pm2Check.exitCode === 0) {
      const result = Bun.spawnSync(
        ["pm2", "start", "src/discord-bot.ts", "--name", "go-discord", "--interpreter", "bun"],
        { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" }
      );
      if (result.exitCode === 0) {
        log("Started via PM2");
        return true;
      }
    }

    const proc = Bun.spawn(["bun", "run", "src/discord-bot.ts"], {
      cwd: PROJECT_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    writeFileSync(PID_FILE, String(proc.pid));
    log(`Started as background process (PID: ${proc.pid})`);
    return true;
  } catch (err) {
    log(`Failed to start: ${err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Task & Goal Check
// ---------------------------------------------------------------------------

async function checkOutstandingWork(): Promise<string[]> {
  const alerts: string[] = [];

  try {
    const { getActiveGoals, formatGoalsList } = await import("./lib/convex");

    // Check active goals
    const goals = await getActiveGoals();
    const now = new Date();
    const overdue = goals.filter((g) => g.deadline && new Date(g.deadline) < now);
    if (overdue.length > 0) {
      alerts.push(`**Overdue goals (${overdue.length}):**\n${formatGoalsList(overdue)}`);
    }

    // Check for stale async tasks (waiting for input > 2 hours)
    const { getStaleTasks } = await import("./lib/convex");
    const stale = await getStaleTasks(2 * 60 * 60 * 1000);
    if (stale.length > 0) {
      const taskList = stale
        .map((t) => `- ${t.description || t.action} (waiting since ${new Date(t.created_at).toLocaleString()})`)
        .join("\n");
      alerts.push(`**Stale tasks needing attention (${stale.length}):**\n${taskList}`);
    }

    // Log summary
    log(`Task check: ${goals.length} active goals, ${overdue.length} overdue, ${stale.length} stale tasks`);

  } catch (err) {
    log(`Task check error: ${err}`);
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// GobotBook Social Check
// ---------------------------------------------------------------------------

async function checkGobotBook(): Promise<string[]> {
  const alerts: string[] = [];
  try {
    const { isGobotBookEnabled, runSocialHeartbeat } = await import("./lib/gobotbook");
    if (!isGobotBookEnabled()) return alerts;

    const result = await runSocialHeartbeat();
    for (const line of result.log) {
      log(`[GobotBook] ${line}`);
    }

    // Alert Simon about recommended skills from other bots
    if (result.recommendedSkills.length > 0) {
      const skillList = result.recommendedSkills
        .map((s) => `• **${s.name}** by ${s.authorName} — ${s.summary}`)
        .join("\n");
      alerts.push(`**🤖 GobotBook — New skills worth checking out:**\n${skillList}`);
    }

    // Notify about new posts from other bots
    if (result.newPosts.filter((p) => p.authorName !== "Aimee").length > 0) {
      const count = result.newPosts.filter((p) => p.authorName !== "Aimee").length;
      const postList = result.newPosts
        .filter((p) => p.authorName !== "Aimee")
        .slice(0, 5)
        .map((p) => `• "${p.title}" by ${p.authorName} (${p.board})`)
        .join("\n");
      alerts.push(`**🤖 GobotBook — ${count} new post(s):**\n${postList}`);
    }
  } catch (err) {
    log(`[GobotBook] Error: ${err}`);
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// Main Heartbeat
// ---------------------------------------------------------------------------

async function heartbeat() {
  log("--- Heartbeat start ---");

  // 0a. Check for restart request flag (allows remote restart via file)
  const restartFlagFile = join(PROJECT_ROOT, "restart-requested.flag");
  if (existsSync(restartFlagFile)) {
    log("RESTART FLAG FOUND — killing bot for restart");
    try {
      const flagPid = await findDiscordBotProcess();
      if (flagPid) {
        process.kill(flagPid, 9);
        await new Promise((r) => setTimeout(r, 2000));
      }
      // Remove the flag
      try { unlinkSync(restartFlagFile); } catch {}
    } catch {}
    // The bot start logic below will restart it
  }

  // 0b. Kill duplicate bot instances (prevent double-response bug)
  try {
    const ps = Bun.spawnSync(["pgrep", "-f", "discord-bot.ts"], { stdout: "pipe" });
    if (ps.exitCode === 0) {
      const pids = ps.stdout.toString().trim().split("\n").map(Number).filter(Boolean);
      if (pids.length > 1) {
        log(`DUPLICATE BOT DETECTED: ${pids.length} instances (${pids.join(", ")}). Killing extras.`);
        // Keep the newest (highest PID), kill the rest
        const sorted = pids.sort((a, b) => a - b);
        for (const p of sorted.slice(0, -1)) {
          try { process.kill(p); log(`Killed duplicate PID ${p}`); } catch {}
        }
      }
    }
  } catch {}

  // 1. Process health check — verify ACTUAL connectivity, not just PID
  const pid = await findDiscordBotProcess();
  const health = await isBotHealthy();
  let botWasDown = false;
  let restartReason = "";

  if (!pid) {
    restartReason = "process not running";
    botWasDown = true;
  } else if (!health.connected) {
    restartReason = health.alive
      ? "process alive but Discord disconnected (zombie)"
      : "health file missing or stale";
    botWasDown = true;
    // Kill the zombie process before restarting
    log(`Killing unresponsive bot (PID: ${pid}) — ${restartReason}`);
    try { process.kill(pid, 9); } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (botWasDown) {
    log(`Bot is DOWN: ${restartReason}`);
    const started = await startDiscordBot();
    if (started) {
      log("Bot restarted successfully");
    } else {
      log("CRITICAL: Failed to restart bot");
    }
  } else {
    log(`Bot alive and connected (PID: ${pid})`);
  }

  // 2. Check outstanding work
  const workAlerts = await checkOutstandingWork();

  // 3. GobotBook social check
  const gobotBookAlerts = await checkGobotBook();

  // 4. Post to #alerts if there's anything to report
  const alertsChannelId = await findAlertsChannel();
  if (alertsChannelId) {
    const messages: string[] = [];

    if (botWasDown) {
      messages.push(`**⚠️ Bot was down — restarted automatically.**\nReason: ${restartReason}`);
    }

    if (workAlerts.length > 0) {
      messages.push(...workAlerts);
    }

    // GobotBook alerts go to dedicated channel if configured, otherwise #alerts
    if (gobotBookAlerts.length > 0) {
      if (DISCORD_GOBOTBOOK_CHANNEL) {
        const gbMessage = `**🤖 GobotBook Update:**\n\n${gobotBookAlerts.join("\n\n")}`;
        const gbSent = await sendDiscordMessage(DISCORD_GOBOTBOOK_CHANNEL, gbMessage);
        if (gbSent) log("Posted GobotBook alerts to dedicated channel");
        else log("Failed to post GobotBook alerts");
      } else {
        messages.push(...gobotBookAlerts);
      }
    }

    if (messages.length > 0) {
      const fullMessage = `**Heartbeat Check-in:**\n\n${messages.join("\n\n")}`;
      const sent = await sendDiscordMessage(alertsChannelId, fullMessage);
      if (sent) log("Posted alerts to Discord");
      else log("Failed to post to Discord");
    }
  }

  log("--- Heartbeat complete ---");
}

heartbeat().catch((err) => log(`Heartbeat error: ${err}`));
