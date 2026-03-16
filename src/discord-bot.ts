/**
 * Go - Discord Bot
 *
 * Discord interface that reuses the same Claude subprocess, memory,
 * agents, and conversation storage as the Telegram bot and CLI chat.
 *
 * Usage: bun run discord
 */

import { Client, GatewayIntentBits, Message as DiscordMessage, Partials } from "discord.js";
import { join } from "path";
import { readFile, writeFile } from "fs/promises";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";

import { loadEnv } from "./lib/env";
import { callClaude as callClaudeSubprocess, callClaudeStreaming, isClaudeErrorResponse } from "./lib/claude";
import {
  processIntents, getMemoryContext, addFact, addGoal,
  completeGoal, deleteFact, cancelGoal, listGoals, listFacts,
} from "./lib/memory";
import { callFallbackLLM } from "./lib/fallback-llm";
import {
  saveMessage, getConversationContext, searchMessages, log as sbLog,
} from "./lib/convex";
import { classifyComplexity } from "./lib/model-router";
import { getAgentConfig, getUserProfile } from "./agents";
import { sanitizeForDiscord, splitMessage, processCrossChannelMessages } from "./lib/discord";
import { sendEmail, isEmailEnabled } from "./lib/email";
import { addOvernightTask } from "./discord-overnight";
import { transcribeAudioBuffer, isTranscriptionEnabled } from "./lib/transcribe";
import { textToSpeech, isVoiceEnabled } from "./lib/voice";
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
to #daily-briefing. Only use this for substantial tasks that benefit from autonomous work.`);

  sections.push(`## USER MESSAGE\n${userMessage}`);

  const fullPrompt = sections.join("\n\n---\n\n");

  let result = await callClaudeSubprocess({
    prompt: fullPrompt,
    outputFormat: "json",
    ...(agentConfig?.allowedTools ? { allowedTools: agentConfig.allowedTools } : {}),
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
      ...(agentConfig?.allowedTools ? { allowedTools: agentConfig.allowedTools } : {}),
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
  console.log(`[DISCORD] Listening for messages${DISCORD_USER_ID ? ` from user ${DISCORD_USER_ID}` : " from everyone (no DISCORD_USER_ID set — open access!)"}`);
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

  // If DISCORD_USER_ID is set, only respond to that user
  if (DISCORD_USER_ID && msg.author.id !== DISCORD_USER_ID) return;

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
      await msg.channel.sendTyping();
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
  try { await msg.channel.sendTyping(); } catch { /* ignore */ }

  // Keep typing active during processing
  const typingInterval = setInterval(async () => {
    try { await msg.channel.sendTyping(); } catch { /* ignore */ }
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

    // Sanitize and send response
    const cleaned = sanitizeForDiscord(response);
    const chunks = splitMessage(cleaned);

    for (const chunk of chunks) {
      await msg.reply(chunk);
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
    await msg.reply("Sorry, I hit an error processing that. Please try again.");
  } finally {
    clearInterval(typingInterval);
  }
});

// ---------------------------------------------------------------------------
// 6. Start
// ---------------------------------------------------------------------------

console.log(`[DISCORD] Starting ${BOT_NAME}...`);
client.login(DISCORD_BOT_TOKEN);
