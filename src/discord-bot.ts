/**
 * Go - Discord Bot
 *
 * Discord interface that reuses the same Claude subprocess, memory,
 * agents, and conversation storage as the Telegram bot and CLI chat.
 *
 * Usage: bun run discord
 */

import {
  Client, GatewayIntentBits, Message as DiscordMessage, Partials,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType,
  type ButtonInteraction,
} from "discord.js";
import { join } from "path";
import { readFile, writeFile } from "fs/promises";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";

import { loadEnv } from "./lib/env";
import { callClaude as callClaudeSubprocess, callClaudeStreaming, isClaudeErrorResponse, READ_ONLY_TOOLS } from "./lib/claude";
import {
  processIntents, getMemoryContext, addFact, addGoal,
  completeGoal, deleteFact, cancelGoal, listGoals, listFacts,
} from "./lib/memory";
import { callFallbackLLM } from "./lib/fallback-llm";
import {
  saveMessage, getConversationContext, searchMessages, log as sbLog,
  maybeCompactConversation,
} from "./lib/convex";
import { classifyComplexity } from "./lib/model-router";
import { getAgentConfig, getUserProfile } from "./agents";
import { sanitizeForDiscord, splitMessage, processCrossChannelMessages } from "./lib/discord";
import { sendEmail, isEmailEnabled } from "./lib/email";
import { addOvernightTask } from "./discord-overnight";
import { transcribeAudioBuffer, isTranscriptionEnabled } from "./lib/transcribe";
import { textToSpeech, isVoiceEnabled } from "./lib/voice";
import { parseClaudeResponse } from "./lib/task-queue";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// 1. Load Environment
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();
await loadEnv(join(PROJECT_ROOT, ".env"));

// Prevent duplicate instances — kill ALL other discord-bot processes
const PID_FILE = join(PROJECT_ROOT, "discord-bot.pid");
try {
  // pkill sends SIGTERM to all matching processes except ourselves
  // Use full command match to catch both "bun run src/discord-bot.ts" variants
  const myPid = process.pid;
  const ps = Bun.spawnSync(["pgrep", "-f", "src/discord-bot\\.ts"], { stdout: "pipe" });
  if (ps.stdout) {
    const pids = ps.stdout.toString().trim().split("\n").map(Number).filter(Boolean);
    const others = pids.filter(p => p !== myPid);
    if (others.length > 0) {
      console.log(`[DISCORD] Found ${others.length} existing bot process(es): ${others.join(", ")}`);
      for (const pid of others) {
        try {
          process.kill(pid, 9); // SIGKILL to ensure they die immediately
          console.log(`[DISCORD] Killed duplicate PID ${pid}`);
        } catch {}
      }
      // Also kill any parent "bun run" processes that spawned them
      const ps2 = Bun.spawnSync(["pgrep", "-f", "bun run src/discord-bot"], { stdout: "pipe" });
      if (ps2.stdout) {
        const parentPids = ps2.stdout.toString().trim().split("\n").map(Number).filter(Boolean);
        for (const pid of parentPids) {
          if (pid !== myPid) {
            try { process.kill(pid, 9); } catch {}
          }
        }
      }
      await new Promise((r) => setTimeout(r, 1000)); // Wait for cleanup
    }
  }
} catch (e) {
  console.log(`[DISCORD] PID guard error (non-fatal): ${e}`);
}
writeFileSync(PID_FILE, String(process.pid));
process.on("exit", () => { try { unlinkSync(PID_FILE); } catch {} });

const TIMEZONE = process.env.USER_TIMEZONE || "UTC";
const BOT_NAME = process.env.BOT_NAME || "Go";
const USER_NAME = process.env.USER_NAME || "User";
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_USER_ID = process.env.DISCORD_USER_ID;

// Build allowed user set: DISCORD_ALLOWED_USERS (comma-separated) takes priority,
// falls back to single DISCORD_USER_ID for backward compatibility.
// If neither is set, the bot responds to everyone (open access).
const ALLOWED_USERS: Set<string> | null = (() => {
  const allowedList = process.env.DISCORD_ALLOWED_USERS;
  if (allowedList) {
    const ids = allowedList.split(",").map(id => id.trim()).filter(Boolean);
    return ids.length > 0 ? new Set(ids) : null;
  }
  if (DISCORD_USER_ID) {
    return new Set([DISCORD_USER_ID]);
  }
  return null;
})();

function isUserAllowed(userId: string): boolean {
  if (!ALLOWED_USERS) return true; // open access
  return ALLOWED_USERS.has(userId);
}

if (!DISCORD_BOT_TOKEN) {
  console.error("DISCORD_BOT_TOKEN is not set in .env");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Session State
// ---------------------------------------------------------------------------

const SESSION_STATE_PATH = join(PROJECT_ROOT, "session-state-discord.json");
let sessionId: string | null = null;

async function loadSessionState(): Promise<void> {
  try {
    const raw = await readFile(SESSION_STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    sessionId = parsed.sessionId || null;
  } catch { /* No saved state */ }
}

async function saveSessionState(): Promise<void> {
  try {
    await writeFile(SESSION_STATE_PATH, JSON.stringify({ sessionId }, null, 2), "utf-8");
  } catch { /* Silent failure */ }
}

await loadSessionState();

// ---------------------------------------------------------------------------
// 2.5 Pending Approval State
// ---------------------------------------------------------------------------

interface PendingApproval {
  question: string;
  options: { label: string; value: string }[];
  channelId: string;
  messageId: string;        // The bot message with buttons
  originalPrompt: string;   // What the user originally asked
  chatId: string;
  agent: string;
  createdAt: number;
}

// Only one pending approval at a time (most recent wins)
let pendingApproval: PendingApproval | null = null;

/**
 * Safe sendTyping — Discord can reject this on partial channels, rate limits,
 * or during gateway instability. Never worth crashing over.
 */
async function safeSendTyping(channel: any): Promise<void> {
  try {
    if (typeof channel.sendTyping === "function") {
      await channel.sendTyping();
    }
  } catch (err: any) {
    console.warn(`[DISCORD] sendTyping failed (non-fatal): ${err.message}`);
  }
}

/**
 * Build Discord action rows with approval buttons.
 * Discord allows max 5 buttons per row, max 5 rows.
 */
function buildApprovalButtons(
  options: { label: string; value: string }[]
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  let currentRow = new ActionRowBuilder<ButtonBuilder>();
  let count = 0;

  for (const opt of options.slice(0, 9)) { // Max 9 option buttons + 1 cancel
    if (count > 0 && count % 5 === 0) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder<ButtonBuilder>();
    }
    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`approve:${opt.value}`)
        .setLabel(opt.label.substring(0, 80))
        .setStyle(opt.value === "yes" ? ButtonStyle.Success : ButtonStyle.Primary)
    );
    count++;
  }

  // Add cancel button
  if (count % 5 === 0 && count > 0) {
    rows.push(currentRow);
    currentRow = new ActionRowBuilder<ButtonBuilder>();
  }
  currentRow.addComponents(
    new ButtonBuilder()
      .setCustomId("approve:cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger)
  );
  rows.push(currentRow);

  return rows;
}

// ---------------------------------------------------------------------------
// 3. Claude Processing (same as cli-chat.ts)
// ---------------------------------------------------------------------------

async function callClaude(
  userMessage: string,
  chatId: string,
  agentName: string = "general"
): Promise<string> {
  const agentConfig = getAgentConfig(agentName);
  const userProfile = await getUserProfile();
  const memoryCtx = await getMemoryContext();
  const conversationCtx = await getConversationContext(chatId, 10);

  const now = new Date().toLocaleString("en-US", {
    timeZone: TIMEZONE, weekday: "long", year: "numeric",
    month: "short", day: "numeric", hour: "2-digit",
    minute: "2-digit", timeZoneName: "short",
  });

  const sections: string[] = [];
  if (agentConfig) {
    sections.push(agentConfig.systemPrompt);
  } else {
    sections.push(`You are ${BOT_NAME}, a personal AI assistant. Be concise, direct, and helpful.`);
  }
  if (userProfile) sections.push(`## USER PROFILE\n${userProfile}`);
  sections.push(`## CURRENT TIME\n${now}`);
  if (memoryCtx) sections.push(`## MEMORY\n${memoryCtx}`);
  if (conversationCtx) sections.push(`## RECENT CONVERSATION\n${conversationCtx}`);
  if (sessionId) sections.push(`## SESSION\nResuming session: ${sessionId}`);

  sections.push(`## INTENT DETECTION
If the user sets a goal, include: [GOAL: description | DEADLINE: deadline]
If a goal is completed, include: [DONE: partial match]
If the user wants to cancel/abandon a goal, include: [CANCEL: partial match]
If you learn a fact worth remembering, include: [REMEMBER: fact]
If the user wants to forget a stored fact, include: [FORGET: partial match]
To send a message to a different Discord channel, include: [SEND:#channelname|Your message here]
To send an email, include: [EMAIL:recipient@example.com|subject|body text]
To queue a task for overnight autonomous work, include: [OVERNIGHT:detailed task description]
These tags will be parsed automatically. Include them naturally in your response.

## EMAIL
You have your own email account: aimee@agentmail.to
You can send, read, reply to, and manage emails. Use the [EMAIL:to|subject|body] tag to send.
For reading/listing, the user can ask and you can use your tools.

## OVERNIGHT WORKER
You can work on tasks autonomously while the user sleeps. When the user gives you a task
to do overnight (research, analysis, writing, etc.), use [OVERNIGHT:task description] to queue it.
The overnight worker runs every 2 hours, uses web search and reasoning, and delivers results
to #daily-briefing. Only use this for substantial tasks that benefit from autonomous work.

## FILESYSTEM ACCESS
You have READ-ONLY access to the entire device filesystem. You can:
- Read any file: use the Read tool with absolute paths (e.g., /home/aimee/somefile.txt)
- Search for files: use the Glob tool (e.g., pattern "**/*.md" in path "/home/aimee")
- Search file contents: use the Grep tool to find text across files
- Fetch web pages: use WebFetch and WebSearch

You CANNOT write, edit, or execute commands on this channel — it is read-only for safety.
When asked to find or read something, always try using your tools first. Do not assume you lack access.

## OBSIDIAN VAULT
You have an Obsidian vault at obsidian/ (relative to your working directory). Use it as your external notepad — read and reference anything in it freely.
Folders: Reflections/ (nightly journal entries), Board/, Briefings/, Daily/, Knowledge/.
Reflections are named YYYY-MM-DD.md. You can search, read, or reference any of them.`);

  sections.push(`## USER MESSAGE\n${userMessage}`);

  const fullPrompt = sections.join("\n\n---\n\n");

  let result = await callClaudeSubprocess({
    prompt: fullPrompt,
    outputFormat: "json",
    permissionMode: "bypassPermissions",
    allowedTools: READ_ONLY_TOOLS,
    resumeSessionId: sessionId || undefined,
    timeoutMs: 180_000, // 3 minutes
    cwd: PROJECT_ROOT,
  });

  // If session resume failed, retry without session (stale session recovery)
  if ((result.isError || !result.text) && sessionId) {
    console.error("[DISCORD] Claude failed with session resume — retrying without session...");
    sessionId = "";
    await saveSessionState();
    result = await callClaudeSubprocess({
      prompt: fullPrompt,
      outputFormat: "json",
      permissionMode: "bypassPermissions",
      allowedTools: READ_ONLY_TOOLS,
      timeoutMs: 180_000,
      cwd: PROJECT_ROOT,
    });
  }

  if (result.sessionId) {
    sessionId = result.sessionId;
    await saveSessionState();
  }

  if (result.isError || !result.text) {
    console.error("[DISCORD] Claude error, trying fallback LLM...");
    try { return await callFallbackLLM(userMessage); }
    catch { return "I'm having trouble processing right now. Please try again."; }
  }

  return result.text;
}

// ---------------------------------------------------------------------------
// 4. Memory Command Handlers
// ---------------------------------------------------------------------------

async function handleMemoryCommand(text: string, chatId: string): Promise<string | null> {
  const lower = text.toLowerCase();

  if (lower.startsWith("remember:")) {
    const fact = text.slice("remember:".length).trim();
    if (fact) {
      const ok = await addFact(fact);
      return ok ? "Noted. I'll remember that." : "Failed to save that. Try again?";
    }
  }
  if (lower.startsWith("track:")) {
    const raw = text.slice("track:".length).trim();
    const deadlineMatch = raw.match(/\|\s*deadline:\s*(.+)$/i);
    const goalText = deadlineMatch ? raw.slice(0, deadlineMatch.index).trim() : raw;
    const deadline = deadlineMatch ? deadlineMatch[1].trim() : undefined;
    if (goalText) {
      const ok = await addGoal(goalText, deadline);
      const note = deadline ? ` (deadline: ${deadline})` : "";
      return ok ? `Goal tracked: "${goalText}"${note}` : "Failed to track that goal.";
    }
  }
  if (lower.startsWith("done:")) {
    const search = text.slice("done:".length).trim();
    if (search) {
      const ok = await completeGoal(search);
      return ok ? "Goal completed! Nice work." : `Couldn't find an active goal matching "${search}".`;
    }
  }
  if (lower.startsWith("forget:")) {
    const search = text.slice("forget:".length).trim();
    if (search) {
      const ok = await deleteFact(search);
      return ok ? "Done. I've forgotten that." : `Couldn't find a stored fact matching "${search}".`;
    }
  }
  if (lower.startsWith("cancel:")) {
    const search = text.slice("cancel:".length).trim();
    if (search) {
      const ok = await cancelGoal(search);
      return ok ? "Goal cancelled and removed." : `Couldn't find an active goal matching "${search}".`;
    }
  }
  if (lower === "goals" || lower === "/goals") {
    return `Active Goals:\n${await listGoals()}`;
  }
  if (lower === "memory" || lower === "facts" || lower === "/memory") {
    return `Stored Facts:\n${await listFacts()}`;
  }
  if (lower.startsWith("recall ") || lower.startsWith("search ") || lower.startsWith("find ")) {
    const query = text.split(/\s+/).slice(1).join(" ");
    if (query) {
      const results = await searchMessages(chatId, query, 5);
      if (results.length === 0) return `No results found for "${query}".`;
      const formatted = results
        .map((msg, i) => {
          const time = msg.created_at ? new Date(msg.created_at).toLocaleDateString() : "unknown";
          const speaker = msg.role === "user" ? "You" : BOT_NAME;
          const snippet = msg.content.length > 200 ? msg.content.substring(0, 200) + "..." : msg.content;
          return `${i + 1}. [${time}] ${speaker}: ${snippet}`;
        })
        .join("\n\n");
      return `Search results for "${query}":\n\n${formatted}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 5. Discord Client
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel], // Required for DMs
});

let currentAgent = "general";
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

client.once("ready", () => {
  isConnected = true;
  reconnectAttempts = 0;
  console.log(`\n[DISCORD] ${BOT_NAME} is online as ${client.user?.tag}`);
  const accessMode = ALLOWED_USERS
    ? `from ${ALLOWED_USERS.size} allowed user(s): ${[...ALLOWED_USERS].join(", ")}`
    : "from everyone (open access — set DISCORD_ALLOWED_USERS to restrict)";
  console.log(`[DISCORD] Listening for messages ${accessMode}`);
  sbLog("info", "discord-bot", "Discord bot started", { tag: client.user?.tag });
});

// --- Resilience: error and disconnect handlers ---

client.on("error", (error) => {
  console.error(`[DISCORD] Client error:`, error.message);
  sbLog("error", "discord-bot", `Client error: ${error.message}`);
});

client.on("warn", (warning) => {
  console.warn(`[DISCORD] Warning: ${warning}`);
});

client.on("shardError", (error, shardId) => {
  console.error(`[DISCORD] Shard ${shardId} error:`, error.message);
  sbLog("error", "discord-bot", `Shard error: ${error.message}`, { shardId });
});

client.on("shardDisconnect", (event, shardId) => {
  isConnected = false;
  console.error(`[DISCORD] Shard ${shardId} disconnected (code: ${event.code}). Will attempt reconnect.`);
  sbLog("error", "discord-bot", `Disconnected (code: ${event.code})`, { shardId });
});

client.on("shardReconnecting", (shardId) => {
  reconnectAttempts++;
  console.log(`[DISCORD] Shard ${shardId} reconnecting (attempt ${reconnectAttempts})...`);
});

client.on("shardResume", (shardId, replayedEvents) => {
  isConnected = true;
  reconnectAttempts = 0;
  console.log(`[DISCORD] Shard ${shardId} resumed (replayed ${replayedEvents} events)`);
  sbLog("info", "discord-bot", `Reconnected after disconnect`, { shardId, replayedEvents });
});

client.on("shardReady", (shardId) => {
  isConnected = true;
  reconnectAttempts = 0;
  console.log(`[DISCORD] Shard ${shardId} ready`);
});

// Watchdog: if disconnected for too long, force restart
setInterval(() => {
  if (!isConnected) {
    console.error(`[DISCORD] Watchdog: not connected. Reconnect attempts: ${reconnectAttempts}`);
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[DISCORD] Watchdog: max reconnect attempts reached. Exiting for restart.`);
      sbLog("error", "discord-bot", "Watchdog: forcing exit after max reconnect attempts");
      process.exit(1); // Heartbeat cron will restart us
    }
  }
}, 60_000); // Check every 60 seconds

// Export connection status for heartbeat health check
writeFileSync(join(PROJECT_ROOT, "discord-bot-health.json"), JSON.stringify({ connected: true, pid: process.pid, startedAt: new Date().toISOString() }));
const healthFile = join(PROJECT_ROOT, "discord-bot-health.json");
setInterval(() => {
  try {
    writeFileSync(healthFile, JSON.stringify({
      connected: isConnected,
      pid: process.pid,
      lastHeartbeat: new Date().toISOString(),
      reconnectAttempts,
    }));
  } catch {}
}, 30_000); // Update health file every 30s

client.on("messageCreate", async (msg: DiscordMessage) => {
  // Ignore bot messages
  if (msg.author.bot) return;

  // Only respond to allowed users (if configured)
  if (!isUserAllowed(msg.author.id)) return;

  let text = msg.content.trim();
  let isVoiceMessage = false;

  // Check for voice message / audio attachment
  // Discord voice messages: check message flags (1 << 13 = IS_VOICE_MESSAGE = 8192)
  const isDiscordVoiceMsg = ((msg.flags?.bitfield || 0) & 8192) !== 0;

  const audioAttachment = msg.attachments.find((a) => {
    const ct = a.contentType?.toLowerCase() || "";
    const name = a.name?.toLowerCase() || "";
    return (
      isDiscordVoiceMsg ||
      ct.startsWith("audio/") ||
      name.endsWith(".ogg") ||
      name.endsWith(".mp3") ||
      name.endsWith(".wav") ||
      name.endsWith(".m4a") ||
      name.endsWith(".webm")
    );
  });

  // Debug logging for any message with attachments
  if (msg.attachments.size > 0) {
    console.log(`[DISCORD] Message has ${msg.attachments.size} attachment(s), flags: ${msg.flags?.bitfield}, isVoiceMsg: ${isDiscordVoiceMsg}`);
    msg.attachments.forEach((a) => {
      console.log(`[DISCORD]   Attachment: ${a.name} | contentType: ${a.contentType} | size: ${a.size}`);
    });
  }

  if (audioAttachment && isTranscriptionEnabled()) {
    isVoiceMessage = true;
    console.log(`[DISCORD] Voice message detected: ${audioAttachment.name} (${audioAttachment.contentType})`);

    try {
      await safeSendTyping(msg.channel);
      const audioRes = await fetch(audioAttachment.url);
      if (!audioRes.ok) throw new Error(`Download failed: ${audioRes.status}`);
      const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

      const mimeType = audioAttachment.contentType || "audio/ogg";
      const transcript = await transcribeAudioBuffer(audioBuffer, mimeType);

      if (transcript && !transcript.startsWith("[")) {
        text = transcript;
        console.log(`[DISCORD] Transcribed: "${transcript.substring(0, 100)}"`);
        // Show the transcription so user knows what was heard
        await msg.reply(`🎙️ *"${transcript}"*`);
      } else {
        console.error(`[DISCORD] Transcription failed: "${transcript}" | mime: ${mimeType} | size: ${audioBuffer.length}`);
        await msg.reply(`Sorry, I couldn't transcribe that audio. Debug: ${transcript} | mime: ${mimeType} | ${audioBuffer.length} bytes`);
        return;
      }
    } catch (err) {
      console.error("[DISCORD] Voice transcription error:", err);
      await msg.reply("Failed to process voice message. Try again or type your message.");
      return;
    }
  }

  if (!text) return;

  // Use channel ID as chat_id for conversation separation
  const chatId = `discord-${msg.channelId}`;

  console.log(`[DISCORD] ${msg.author.username}: ${text.substring(0, 100)}${text.length > 100 ? "..." : ""}`);

  // Help command
  if (text === "/help" || text === "!help") {
    await msg.reply(`**${BOT_NAME} — Discord Bot**

**Commands:**
\`remember: <fact>\` — Save a fact to memory
\`track: <goal>\` — Track a goal (add \`| deadline: date\`)
\`done: <goal>\` — Mark a goal as complete
\`forget: <fact>\` — Remove a stored fact
\`cancel: <goal>\` — Cancel/remove a goal
\`goals\` — List active goals
\`memory\` / \`facts\` — List stored facts
\`recall/search/find <q>\` — Search conversation history
\`/agent <name>\` — Switch agent (general, research, content, finance, strategy, critic, cto, coo)
\`/reflect\` — Run a reflection on today's conversations and thoughts
\`/approve\` — Approve a pending action (or click the button)
\`/approve <n>\` — Approve option number n
\`/deny\` — Deny/cancel a pending action
\`/restart\` — Restart the bot remotely (deploys code changes)

**Voice Messages:**
Send a voice message in any text channel — I'll transcribe it, process it, and reply with both text and audio.

**Overnight Worker:**
Just tell me to work on something overnight, e.g. "Research the top AI agent frameworks overnight"
I'll queue the task and deliver results to #daily-briefing by morning.

Otherwise, just type your message.`);
    return;
  }

  // Remote restart command
  if (text === "/restart" || text === "!restart") {
    console.log(`[DISCORD] Restart requested by ${msg.author.username}`);
    await msg.reply("♻️ Restarting now... I'll be back in a few seconds.");
    sbLog("info", "discord-bot", `Restart requested by ${msg.author.username}`);

    // Write restart flag, then exit. The new process's PID guard will not
    // find a stale process because we exit cleanly. We spawn the replacement
    // AFTER destroying the Discord client so the new instance can log in
    // without gateway conflicts.
    setTimeout(async () => {
      try { client.destroy(); } catch {}
      // Small delay to let the Discord gateway disconnect
      await new Promise((r) => setTimeout(r, 500));
      const child = Bun.spawn(["bun", "run", "src/discord-bot.ts"], {
        cwd: PROJECT_ROOT,
        stdout: "inherit",
        stderr: "inherit",
        env: process.env,
        ipc: undefined,
      });
      child.unref(); // Don't keep this process alive waiting for child
      console.log(`[DISCORD] New instance spawned (PID: ${child.pid}). Exiting old process now.`);
      process.exit(0);
    }, 500);
    return;
  }

  // Agent switch
  if (text.startsWith("/agent ") || text.startsWith("!agent ")) {
    const name = text.split(/\s+/)[1]?.toLowerCase();
    const config = getAgentConfig(name);
    if (config) {
      currentAgent = name;
      await msg.reply(`Switched to **${config.name}** agent.`);
    } else {
      await msg.reply(`Unknown agent "${name}". Available: general, research, content, finance, strategy, critic, cto, coo`);
    }
    return;
  }

  // Reflect command — on-demand nightly reflection
  if (text === "/reflect" || text === "!reflect") {
    await msg.reply("🪞 Running reflection... gathering today's inputs and thinking it over.");
    await safeSendTyping(msg.channel);
    try {
      const { gatherDayInputs, runReflection, storeReflection } = await import("./discord-reflection");
      const today = new Date().toLocaleDateString("en-CA", { timeZone: process.env.USER_TIMEZONE || "UTC" });
      const inputs = await gatherDayInputs();
      const inputSummary = `Messages: ${inputs.messages.length} chars, Goals: ${inputs.goals.length} chars, Facts: ${inputs.facts.length} chars, GobotBook: ${inputs.gobotbook}`;
      const reflection = await runReflection(inputs);
      await storeReflection(today, reflection, inputSummary);
      const reply = `🪞 **Reflection — ${today}**\n\n${reflection.content}\n\n**Themes:** ${reflection.themes.join(", ") || "none"}\n\n**Carry forward:**\n${reflection.carryForward}`;
      const chunks = splitMessage(reply);
      for (const chunk of chunks) {
        await msg.reply(chunk);
      }
    } catch (err) {
      await msg.reply(`❌ Reflection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // Approve command — text-based approval for pending actions
  if (text === "/approve" || text === "!approve") {
    await handleTextApproval(msg, chatId, "yes");
    return;
  }
  if (text === "/deny" || text === "!deny") {
    await handleTextApproval(msg, chatId, "cancel");
    return;
  }
  // Numbered approval: /approve 2 selects option 2
  const approveNumMatch = text.match(/^[/!]approve\s+(\d+)$/);
  if (approveNumMatch) {
    await handleTextApproval(msg, chatId, approveNumMatch[1]);
    return;
  }

  // Memory commands
  const memoryResult = await handleMemoryCommand(text, chatId);
  if (memoryResult !== null) {
    const chunks = splitMessage(memoryResult);
    for (const chunk of chunks) {
      await msg.reply(chunk);
    }
    return;
  }

  // Save user message to database
  await saveMessage({
    chat_id: chatId,
    role: "user",
    content: text,
    metadata: { source: "discord", authorId: msg.author.id, username: msg.author.username },
  });

  // Show typing indicator
  await safeSendTyping(msg.channel);

  // Keep typing active during processing
  const typingInterval = setInterval(async () => {
    await safeSendTyping(msg.channel);
  }, 8000);

  try {
    // Process with Claude
    const response = await callClaude(text, chatId, currentAgent);

    // Save assistant message
    await saveMessage({
      chat_id: chatId,
      role: "assistant",
      content: response,
      metadata: { agent: currentAgent, source: "discord" },
    });

    // Trigger session compaction in the background (non-blocking)
    maybeCompactConversation(chatId).catch(() => {});

    // Process intents (goals, facts, etc.)
    await processIntents(response);

    // Process cross-channel sends (e.g. [SEND:#alerts|message])
    await processCrossChannelMessages(client, response);

    // Process email sends (e.g. [EMAIL:to|subject|body])
    if (isEmailEnabled()) {
      const emailRegex = /\[EMAIL:([^|]+)\|([^|]+)\|([^\]]+)\]/gi;
      let emailMatch;
      while ((emailMatch = emailRegex.exec(response)) !== null) {
        const [, to, subject, body] = emailMatch;
        try {
          await sendEmail({ to: to.trim(), subject: subject.trim(), text: body.trim() });
          console.log(`[DISCORD] Email sent to ${to.trim()}`);
        } catch (err) {
          console.error(`[DISCORD] Email send failed:`, err);
        }
      }
    }

    // Process overnight task tags (e.g. [OVERNIGHT:task description])
    const overnightRegex = /\[OVERNIGHT:([^\]]+)\]/gi;
    let overnightMatch;
    while ((overnightMatch = overnightRegex.exec(response)) !== null) {
      const taskDesc = overnightMatch[1].trim();
      try {
        const task = addOvernightTask(taskDesc);
        console.log(`[DISCORD] Overnight task queued: ${task.id} — "${taskDesc.substring(0, 60)}"`);
      } catch (err) {
        console.error(`[DISCORD] Failed to queue overnight task:`, err);
      }
    }

    // Check if Claude is asking for approval / user input
    const parsed = parseClaudeResponse(response);
    const cleaned = sanitizeForDiscord(response);
    const chunks = splitMessage(cleaned);

    if (parsed.needsInput && parsed.options.length > 0) {
      // Send the response text first (all chunks except maybe attach buttons to last)
      for (let i = 0; i < chunks.length - 1; i++) {
        await msg.reply(chunks[i]);
      }
      // Send last chunk with approval buttons
      const rows = buildApprovalButtons(parsed.options);
      const buttonMsg = await msg.reply({
        content: chunks[chunks.length - 1],
        components: rows,
      });

      pendingApproval = {
        question: parsed.question || "",
        options: parsed.options,
        channelId: msg.channelId,
        messageId: buttonMsg.id,
        originalPrompt: text,
        chatId,
        agent: currentAgent,
        createdAt: Date.now(),
      };
      console.log(`[DISCORD] Approval requested: "${parsed.question?.substring(0, 80)}"`);
    } else {
      for (const chunk of chunks) {
        await msg.reply(chunk);
      }
    }

    // If the user sent a voice message, also reply with a voice note
    if (isVoiceMessage && isVoiceEnabled()) {
      try {
        // Use cleaned text (without intent tags) for TTS
        const ttsText = cleaned.length > 4000 ? cleaned.substring(0, 4000) + "..." : cleaned;
        const audioBuffer = await textToSpeech(ttsText);
        if (audioBuffer) {
          const tmpPath = join(tmpdir(), `gobot-reply-${Date.now()}.wav`);
          await writeFile(tmpPath, audioBuffer);
          await msg.channel.send({
            files: [{ attachment: tmpPath, name: "reply.wav" }],
          });
          await unlink(tmpPath).catch(() => {});
          console.log("[DISCORD] Voice reply sent");
        }
      } catch (err) {
        console.error("[DISCORD] TTS reply error:", err);
        // Text reply already sent — voice is a bonus, don't error out
      }
    }
  } catch (err) {
    console.error("[DISCORD] Error processing message:", err);
    try {
      await msg.reply("Sorry, I hit an error processing that. Please try again.");
    } catch (replyErr) {
      console.error("[DISCORD] Failed to send error reply (Discord may be down):", (replyErr as any).message);
    }
  } finally {
    clearInterval(typingInterval);
  }
});

// ---------------------------------------------------------------------------
// 6. Approval Handlers (HITL for Discord)
// ---------------------------------------------------------------------------

/**
 * Handle text-based approval (/approve, /deny, /approve 2)
 */
async function handleTextApproval(
  msg: DiscordMessage,
  chatId: string,
  choice: string
): Promise<void> {
  if (!pendingApproval) {
    await msg.reply("No pending approval right now.");
    return;
  }

  await resolveApproval(msg, choice);
}

/**
 * Resolve a pending approval — either from button click or text command.
 * Sends the user's choice back to Claude as a follow-up message in the same session.
 */
async function resolveApproval(
  replyTarget: DiscordMessage | ButtonInteraction,
  choice: string
): Promise<void> {
  if (!pendingApproval) return;

  const approval = pendingApproval;
  pendingApproval = null; // Clear immediately to prevent double-resolve

  // Disable buttons on the original message
  try {
    const channel = client.channels.cache.get(approval.channelId);
    if (channel && "messages" in channel) {
      const buttonMsg = await (channel as any).messages.fetch(approval.messageId);
      if (buttonMsg?.editable) {
        await buttonMsg.edit({ components: [] }); // Remove buttons
      }
    }
  } catch { /* non-critical */ }

  const isButtonInteraction = !("content" in replyTarget);

  if (choice === "cancel") {
    if (isButtonInteraction) {
      await (replyTarget as ButtonInteraction).reply({ content: "Cancelled.", flags: 64 });
    } else {
      await (replyTarget as DiscordMessage).reply("Cancelled.");
    }
    return;
  }

  // Map choice back to option label for context
  let choiceText = choice;
  const option = approval.options.find((o) => o.value === choice);
  if (option) choiceText = option.label;

  // Acknowledge
  const ackText = `Approved: **${choiceText}**. Processing...`;
  if (isButtonInteraction) {
    await (replyTarget as ButtonInteraction).reply(ackText);
  } else {
    await (replyTarget as DiscordMessage).reply(ackText);
  }

  // Show typing
  const approvalChannel = client.channels.cache.get(approval.channelId);
  await safeSendTyping(approvalChannel);

  const typingInterval = setInterval(async () => {
    await safeSendTyping(approvalChannel);
  }, 8000);

  try {
    // Resume the Claude session with the user's approval
    const followUp = `The user approved: "${choiceText}". Proceed with the action. Do not ask for confirmation again.`;

    const response = await callClaude(followUp, approval.chatId, approval.agent);

    await saveMessage({
      chat_id: approval.chatId,
      role: "user",
      content: `[Approved: ${choiceText}]`,
      metadata: { source: "discord", type: "approval" },
    });
    await saveMessage({
      chat_id: approval.chatId,
      role: "assistant",
      content: response,
      metadata: { agent: approval.agent, source: "discord" },
    });

    await processIntents(response);
    await processCrossChannelMessages(client, response);

    const cleaned = sanitizeForDiscord(response);
    const chunks = splitMessage(cleaned);

    // Check if the follow-up also needs approval
    const parsed = parseClaudeResponse(response);
    if (parsed.needsInput && parsed.options.length > 0) {
      const channel = client.channels.cache.get(approval.channelId);
      for (let i = 0; i < chunks.length - 1; i++) {
        if (channel && "send" in channel) await (channel as any).send(chunks[i]);
      }
      const rows = buildApprovalButtons(parsed.options);
      if (channel && "send" in channel) {
        const newButtonMsg = await (channel as any).send({
          content: chunks[chunks.length - 1],
          components: rows,
        });
        pendingApproval = {
          question: parsed.question || "",
          options: parsed.options,
          channelId: approval.channelId,
          messageId: newButtonMsg.id,
          originalPrompt: approval.originalPrompt,
          chatId: approval.chatId,
          agent: approval.agent,
          createdAt: Date.now(),
        };
      }
    } else {
      for (const chunk of chunks) {
        const channel = client.channels.cache.get(approval.channelId);
        if (channel && "send" in channel) {
          await (channel as any).send(chunk);
        }
      }
    }
  } catch (err) {
    console.error("[DISCORD] Approval follow-up error:", err);
    try {
      const channel = client.channels.cache.get(approval.channelId);
      if (channel && "send" in channel) {
        await (channel as any).send("Sorry, I hit an error processing the approved action. Please try again.");
      }
    } catch {}
  } finally {
    clearInterval(typingInterval);
  }
}

// ---------------------------------------------------------------------------
// 7. Button Interaction Handler
// ---------------------------------------------------------------------------

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const buttonInteraction = interaction as ButtonInteraction;
  const customId = buttonInteraction.customId;

  // Only handle our approval buttons
  if (!customId.startsWith("approve:")) return;

  // Check if the user is authorized
  if (!isUserAllowed(buttonInteraction.user.id)) {
    await buttonInteraction.reply({
      content: "Only authorized users can approve actions.",
      flags: 64, // ephemeral
    });
    return;
  }

  const choice = customId.replace("approve:", "");
  console.log(`[DISCORD] Button approval: ${choice} by ${buttonInteraction.user.username}`);

  await resolveApproval(buttonInteraction, choice);
});

// ---------------------------------------------------------------------------
// 8. Start
// ---------------------------------------------------------------------------

// Catch unhandled rejections from Discord.js internals (gateway fetches, etc.)
// Without this, a transient Discord API failure can crash the entire process.
process.on("unhandledRejection", (reason: any) => {
  const msg = reason?.message || String(reason);
  console.error(`[DISCORD] Unhandled rejection (suppressed crash): ${msg}`);
  sbLog("error", "discord-bot", `Unhandled rejection: ${msg}`);
});

console.log(`[DISCORD] Starting ${BOT_NAME}...`);

// Resilient login — retry on gateway failures (Discord outages, rate limits)
async function loginWithRetry(retries = 3, delayMs = 5000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await client.login(DISCORD_BOT_TOKEN);
      return;
    } catch (err: any) {
      console.error(`[DISCORD] Login attempt ${attempt}/${retries} failed: ${err.message}`);
      sbLog("error", "discord-bot", `Login failed (attempt ${attempt})`, { error: err.message });
      if (attempt < retries) {
        console.log(`[DISCORD] Retrying in ${delayMs / 1000}s...`);
        await new Promise(r => setTimeout(r, delayMs));
        delayMs *= 2; // exponential backoff
      } else {
        console.error(`[DISCORD] All login attempts exhausted. Exiting for restart.`);
        process.exit(1);
      }
    }
  }
}

loginWithRetry();
