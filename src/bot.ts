/**
 * Go - Telegram Bot Daemon
 *
 * Core relay that connects Telegram to Claude Code.
 * Handles text, voice, photo, and document messages with
 * multi-agent routing, persistent memory, and fallback LLM chain.
 *
 * Usage: bun run src/bot.ts
 */

import { Bot, Context, InputFile, InlineKeyboard } from "grammy";
import { join } from "path";
import { readFile, writeFile, mkdir, unlink, stat } from "fs/promises";
import { createWriteStream, existsSync } from "fs";

// ---------------------------------------------------------------------------
// Local Modules
// ---------------------------------------------------------------------------

import { loadEnv } from "./lib/env";
import { sanitizeForTelegram, sendResponse, createTypingIndicator } from "./lib/telegram";
import { callClaude as callClaudeSubprocess, callClaudeStreaming, isClaudeErrorResponse, READ_ONLY_TOOLS } from "./lib/claude";
import {
  processIntents,
  getMemoryContext,
  addFact,
  addGoal,
  completeGoal,
  deleteFact,
  cancelGoal,
  listGoals,
  listFacts,
} from "./lib/memory";
import { uploadAssetQuick, updateAssetDescription, parseAssetDescTag, stripAssetDescTag } from "./lib/asset-store";
import { callFallbackLLM } from "./lib/fallback-llm";
import { textToSpeech, initiatePhoneCall, isVoiceEnabled, isCallEnabled, waitForTranscript, summarizeTranscript, extractTaskFromTranscript } from "./lib/voice";
import { transcribeAudio, isTranscriptionEnabled } from "./lib/transcribe";
import {
  saveMessage,
  getConversationContext,
  searchMessages,
  getRecentMessages,
  log as sbLog,
  createTask,
  updateTask,
} from "./lib/convex";

// Task Queue (Human-in-the-Loop)
import {
  parseClaudeResponse,
  buildTaskKeyboard,
  handleTaskCallback,
  formatTaskStatus,
  checkStaleTasks,
} from "./lib/task-queue";

// VPS Anthropic Processor (for resuming VPS tasks)
import {
  processWithAnthropic,
  type ResumeState,
} from "./lib/anthropic-processor";
import {
  processWithAgentSDK,
  type AgentResumeState,
} from "./lib/agent-session";

// Model Router (UX-only on Mac — controls progress updates, not model selection)
import { classifyComplexity } from "./lib/model-router";

// Multi-Bot Agent Identity
import { BotRegistry } from "./lib/bot-registry";
import { parseInvocationTags, stripInvocationTags, executeVisibleInvocation } from "./lib/cross-agent";

// Agents
import {
  getAgentConfig,
  getAgentByTopicId,
  formatCrossAgentContext,
  getUserProfile,
} from "./agents";
import { gatherBoardData } from "./lib/board-data";

// ---------------------------------------------------------------------------
// 1. Load Environment
// ---------------------------------------------------------------------------

await loadEnv(join(process.cwd(), ".env"));

// ---------------------------------------------------------------------------
// 2. Configuration
// ---------------------------------------------------------------------------

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID;
const PROJECT_ROOT = process.cwd();
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const TIMEZONE = process.env.USER_TIMEZONE || "UTC";
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "3000", 10);
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || "";

if (!BOT_TOKEN) {
  console.error("FATAL: TELEGRAM_BOT_TOKEN is required. Set it in .env");
  process.exit(1);
}

if (!ALLOWED_USER_ID) {
  console.error("FATAL: TELEGRAM_USER_ID is required. Set it in .env");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// Multi-bot registry (agent-specific bots for visible identities)
const botRegistry = new BotRegistry(bot);

// ---------------------------------------------------------------------------
// 3. Session State Management
// ---------------------------------------------------------------------------

interface SessionState {
  sessionId: string | null;
  pendingFiles: string[];
}

const SESSION_STATE_PATH = join(PROJECT_ROOT, "session-state.json");

let sessionState: SessionState = {
  sessionId: null,
  pendingFiles: [],
};

async function loadSessionState(): Promise<void> {
  try {
    const raw = await readFile(SESSION_STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    sessionState = {
      sessionId: parsed.sessionId || null,
      pendingFiles: Array.isArray(parsed.pendingFiles) ? parsed.pendingFiles : [],
    };
  } catch {
    // No saved state, use defaults
  }
}

async function saveSessionState(): Promise<void> {
  try {
    await writeFile(SESSION_STATE_PATH, JSON.stringify(sessionState, null, 2), "utf-8");
  } catch {
    // Silent failure
  }
}

await loadSessionState();

// ---------------------------------------------------------------------------
// 4. Process Lock (Prevent Multiple Instances)
// ---------------------------------------------------------------------------

const LOCK_FILE = join(PROJECT_ROOT, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    // Check if lock file exists and is fresh (heartbeat within last 90s)
    const lockStat = await stat(LOCK_FILE).catch(() => null);
    if (lockStat) {
      const lockAge = Date.now() - lockStat.mtimeMs;
      if (lockAge < 90_000) {
        console.error("FATAL: Another instance is running (bot.lock is fresh). Exiting.");
        return false;
      }
      console.log("Stale lock file found, taking over...");
    }

    // Write our PID as the lock
    await writeFile(LOCK_FILE, String(process.pid), "utf-8");
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(): Promise<void> {
  try {
    await unlink(LOCK_FILE);
  } catch {
    // Lock file may already be gone
  }
}

// Heartbeat: touch lock file every 60s to signal we're alive
const heartbeatInterval = setInterval(async () => {
  try {
    await writeFile(LOCK_FILE, String(process.pid), "utf-8");
  } catch {
    // Non-critical
  }
}, 60_000);

// Stale task reminders: check every 15 minutes
const staleTaskInterval = setInterval(async () => {
  try {
    if (BOT_TOKEN && ALLOWED_USER_ID) {
      const reminded = await checkStaleTasks(BOT_TOKEN, ALLOWED_USER_ID);
      if (reminded > 0) {
        console.log(`Sent ${reminded} stale task reminder(s)`);
      }
    }
  } catch (err) {
    console.error("Stale task check error:", err);
  }
}, 15 * 60 * 1000);

if (!(await acquireLock())) {
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 5. Graceful Shutdown
// ---------------------------------------------------------------------------

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\nReceived ${signal}. Shutting down gracefully...`);

  clearInterval(heartbeatInterval);
  clearInterval(staleTaskInterval);

  try {
    bot.stop();
  } catch {
    // Bot may not have started
  }

  await saveSessionState();
  await releaseLock();
  await sbLog("info", "bot", `Shutdown: ${signal}`);

  console.log("Shutdown complete.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
process.on("uncaughtException", async (error) => {
  console.error("Uncaught exception:", error);
  await sbLog("error", "bot", `Uncaught exception: ${error.message}`, {
    stack: error.stack,
  });
  await shutdown("uncaughtException");
});

// ---------------------------------------------------------------------------
// 6. Security Middleware
// ---------------------------------------------------------------------------

// Global error handler — prevents Grammy from dumping full Context objects
bot.catch((err) => {
  const e = err.error;
  const errMsg = e instanceof Error ? e.message : String(e);
  console.error(`BotError [update ${err.ctx?.update?.update_id}]: ${errMsg}`);
});

bot.use(async (ctx, next) => {
  const userId = String(ctx.from?.id || "");
  if (userId !== ALLOWED_USER_ID) {
    // Silently ignore messages from unauthorized users
    return;
  }
  await next();
});

// ---------------------------------------------------------------------------
// 7. Message Handlers
// ---------------------------------------------------------------------------

// --- Text Messages ---

bot.on("message:text", (ctx) => {
  // Fire-and-forget: don't block Grammy's update loop
  handleTextMessage(ctx).catch((err) => {
    console.error("Text handler error:", err);
  });
});

async function handleTextMessage(ctx: Context): Promise<void> {
  const text = ctx.message?.text?.trim();
  if (!text) return;

  const chatId = String(ctx.chat?.id || "");
  const topicId = (ctx.message as any)?.message_thread_id as number | undefined;
  const lowerText = text.toLowerCase();

  // Persist user message
  await saveMessage({
    chat_id: chatId,
    role: "user",
    content: text,
    metadata: { topicId, messageId: ctx.message?.message_id },
  });

  // ----- Memory Commands -----

  // remember: <fact>
  if (lowerText.startsWith("remember:")) {
    const fact = text.slice("remember:".length).trim();
    if (fact) {
      const success = await addFact(fact);
      const reply = success ? `Noted. I'll remember that.` : `Failed to save that. Try again?`;
      await ctx.reply(reply);
      return;
    }
  }

  // track: <goal> [| deadline: <deadline>]
  if (lowerText.startsWith("track:")) {
    const raw = text.slice("track:".length).trim();
    const deadlineMatch = raw.match(/\|\s*deadline:\s*(.+)$/i);
    const goalText = deadlineMatch ? raw.slice(0, deadlineMatch.index).trim() : raw;
    const deadline = deadlineMatch ? deadlineMatch[1].trim() : undefined;

    if (goalText) {
      const success = await addGoal(goalText, deadline);
      const deadlineNote = deadline ? ` (deadline: ${deadline})` : "";
      const reply = success
        ? `Goal tracked: "${goalText}"${deadlineNote}`
        : `Failed to track that goal.`;
      await ctx.reply(reply);
      return;
    }
  }

  // done: <partial goal match>
  if (lowerText.startsWith("done:")) {
    const search = text.slice("done:".length).trim();
    if (search) {
      const success = await completeGoal(search);
      const reply = success
        ? `Goal completed! Nice work.`
        : `Couldn't find an active goal matching "${search}".`;
      await ctx.reply(reply);
      return;
    }
  }

  // forget: <partial fact match>
  if (lowerText.startsWith("forget:")) {
    const search = text.slice("forget:".length).trim();
    if (search) {
      const success = await deleteFact(search);
      const reply = success
        ? `Done. I've forgotten that.`
        : `Couldn't find a stored fact matching "${search}".`;
      await ctx.reply(reply);
      return;
    }
  }

  // cancel: <partial goal match>
  if (lowerText.startsWith("cancel:")) {
    const search = text.slice("cancel:".length).trim();
    if (search) {
      const success = await cancelGoal(search);
      const reply = success
        ? `Goal cancelled and removed.`
        : `Couldn't find an active goal matching "${search}".`;
      await ctx.reply(reply);
      return;
    }
  }

  // goals
  if (lowerText === "goals" || lowerText === "/goals") {
    const goals = await listGoals();
    await ctx.reply(`**Active Goals:**\n${goals}`, { parse_mode: "Markdown" }).catch(() =>
      ctx.reply(`Active Goals:\n${goals}`)
    );
    return;
  }

  // memory / facts
  if (lowerText === "memory" || lowerText === "facts" || lowerText === "/memory") {
    const facts = await listFacts();
    await ctx.reply(`**Stored Facts:**\n${facts}`, { parse_mode: "Markdown" }).catch(() =>
      ctx.reply(`Stored Facts:\n${facts}`)
    );
    return;
  }

  // /tasks — show active async tasks
  if (lowerText === "/tasks" || lowerText === "tasks") {
    const status = await formatTaskStatus(chatId);
    await ctx.reply(status, { parse_mode: "Markdown" }).catch(() => ctx.reply(status));
    return;
  }

  // ----- Semantic Search -----

  if (
    lowerText.startsWith("recall ") ||
    lowerText.startsWith("search ") ||
    lowerText.startsWith("find ")
  ) {
    const query = text.split(/\s+/).slice(1).join(" ");
    if (query) {
      const typing = createTypingIndicator(ctx);
      typing.start();
      try {
        const results = await searchMessages(chatId, query, 5);
        if (results.length === 0) {
          await ctx.reply(`No results found for "${query}".`);
        } else {
          const formatted = results
            .map((msg, i) => {
              const time = msg.created_at
                ? new Date(msg.created_at).toLocaleDateString()
                : "unknown";
              const speaker = msg.role === "user" ? "User" : "Bot";
              const snippet = msg.content.length > 200
                ? msg.content.substring(0, 200) + "..."
                : msg.content;
              return `${i + 1}. [${time}] ${speaker}: ${snippet}`;
            })
            .join("\n\n");
          await ctx.reply(`**Search results for "${query}":**\n\n${formatted}`, {
            parse_mode: "Markdown",
          }).catch(() => ctx.reply(`Search results for "${query}":\n\n${formatted}`));
        }
      } finally {
        typing.stop();
      }
      return;
    }
  }

  // ----- Critic Mode -----

  if (lowerText.startsWith("/critic ") || lowerText.startsWith("/critic\n")) {
    const idea = text.slice("/critic".length).trim();
    if (idea) {
      await callClaudeAndReply(ctx, chatId, idea, "critic", topicId);
      return;
    }
  }

  // ----- Board Meeting -----

  if (
    lowerText === "/board" ||
    lowerText === "board meeting" ||
    lowerText.startsWith("/board ")
  ) {
    const extraContext = text.replace(/^\/board\s*/i, "").replace(/^board meeting\s*/i, "").trim();
    await runBoardMeeting(chatId, topicId, extraContext || undefined);
    return;
  }

  // ----- Phone Call -----

  if (lowerText.includes("call me") && isCallEnabled()) {
    const context = text.replace(/call me/i, "").trim();
    const profile = await getUserProfile();
    const userName = extractUserName(profile);
    await ctx.reply("Initiating call...");
    const result = await initiatePhoneCall(context, userName);

    if (result.success) {
      await ctx.reply(`Call started! ${result.message}`);

      // Wait for transcript in the background
      if (result.conversationId) {
        waitForTranscript(result.conversationId).then(async (transcript) => {
          if (transcript) {
            // Summarize and save transcript
            const summary = await summarizeTranscript(transcript);
            await saveMessage({
              chat_id: chatId,
              role: "assistant",
              content: `[Phone call transcript]\n${transcript}\n\n[Summary]\n${summary}`,
              metadata: { type: "call_transcript", conversationId: result.conversationId },
            });
            await ctx.reply(`*Call Summary*\n\n${summary}`, { parse_mode: "Markdown" })
              .catch(() => ctx.reply(`Call Summary\n\n${summary}`));

            // Extract and auto-execute any tasks from the call
            try {
              const task = await extractTaskFromTranscript(transcript, summary);
              if (task) {
                console.log(`Task detected from call: "${task.substring(0, 80)}"`);
                await ctx.reply(`*Starting task from call:*\n${task}`, { parse_mode: "Markdown" })
                  .catch(() => ctx.reply(`Starting task from call:\n${task}`));

                // Use the full callClaudeAndReply flow (handles streaming, intents, HITL)
                await callClaudeAndReply(ctx, chatId, task, "general", topicId);
              }
            } catch (taskErr) {
              console.error("Call task extraction/execution failed:", taskErr);
            }
          }
        }).catch((err) => {
          console.error("Transcript polling failed:", err);
        });
      }
    } else {
      await ctx.reply(`Could not start call: ${result.message}`);
    }
    return;
  }

  // ----- Default: Claude Processing -----

  // Determine agent from topic (if forum mode)
  const agentName = topicId ? getAgentByTopicId(topicId) || "general" : "general";
  await callClaudeAndReply(ctx, chatId, text, agentName, topicId);
}

// --- Voice Messages ---

bot.on("message:voice", (ctx) => {
  handleVoiceMessage(ctx).catch((err) => {
    console.error("Voice handler error:", err);
  });
});

async function handleVoiceMessage(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id || "");
  const typing = createTypingIndicator(ctx);
  typing.start();

  try {
    // Download voice file
    const file = await ctx.getFile();
    const filePath = file.file_path;
    if (!filePath) {
      await ctx.reply("Could not download voice message.");
      return;
    }

    const uploadsDir = join(PROJECT_ROOT, "uploads");
    await mkdir(uploadsDir, { recursive: true });

    const localPath = join(uploadsDir, `voice_${Date.now()}.ogg`);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(localPath, buffer);

    // Transcribe
    const transcript = await transcribeAudio(localPath);

    // Persist user message (transcribed)
    await saveMessage({
      chat_id: chatId,
      role: "user",
      content: `[Voice message] ${transcript}`,
      metadata: { type: "voice", originalFile: localPath },
    });

    // Process with Claude (uses same complexity-aware routing as text messages)
    const topicId = (ctx.message as any)?.message_thread_id as number | undefined;
    const agentName = topicId ? getAgentByTopicId(topicId) || "general" : "general";

    const voicePrompt = `[Voice message transcription]: ${transcript}`;
    const tier = classifyComplexity(voicePrompt);
    let claudeResponse: string;

    if (tier !== "haiku") {
      // Complex task → streaming subprocess with live progress
      claudeResponse = await callClaudeWithProgress(ctx, voicePrompt, chatId, agentName, topicId);
    } else {
      // Simple task → standard subprocess (fast, no progress needed)
      claudeResponse = await callClaude(voicePrompt, chatId, agentName, topicId);
    }

    // Persist bot response
    await saveMessage({
      chat_id: chatId,
      role: "assistant",
      content: claudeResponse,
      metadata: { type: "voice_reply" },
    });

    // Process intents
    await processIntents(claudeResponse);

    // Reply with voice if voice is enabled, otherwise text
    await sendResponse(ctx, claudeResponse, isVoiceEnabled(), textToSpeech);

    // Cleanup temp file
    await unlink(localPath).catch(() => {});
  } catch (error) {
    console.error("Voice processing error:", error);
    await ctx.reply("Sorry, I couldn't process that voice message. Please try again.");
  } finally {
    typing.stop();
  }
}

// --- Photo Messages ---

bot.on("message:photo", (ctx) => {
  handlePhotoMessage(ctx).catch((err) => {
    console.error("Photo handler error:", err);
  });
});

async function handlePhotoMessage(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id || "");
  const typing = createTypingIndicator(ctx);
  typing.start();

  try {
    // Get highest resolution photo
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) {
      await ctx.reply("Could not process photo.");
      return;
    }

    const largest = photos[photos.length - 1];
    const file = await ctx.api.getFile(largest.file_id);
    const filePath = file.file_path;
    if (!filePath) {
      await ctx.reply("Could not download photo.");
      return;
    }

    // Download photo locally (Claude Code reads from filesystem)
    const uploadsDir = join(PROJECT_ROOT, "uploads");
    await mkdir(uploadsDir, { recursive: true });

    const ext = filePath.split(".").pop() || "jpg";
    const localPath = join(uploadsDir, `photo_${Date.now()}.${ext}`);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(localPath, buffer);

    const caption = ctx.message?.caption || "User sent a photo. Describe and respond to it.";

    // Upload to Supabase Storage with placeholder (async, don't block)
    const asset = await uploadAssetQuick(localPath, {
      userCaption: caption,
      channel: "telegram",
      telegramFileId: largest.file_id,
      originalFilename: `photo_${Date.now()}.${ext}`,
    });

    // Persist user message
    await saveMessage({
      chat_id: chatId,
      role: "user",
      content: `[Photo] ${caption}`,
      metadata: { type: "photo", filePath: localPath, assetId: asset?.id },
    });

    // Process with Claude (uses same complexity-aware routing as text messages)
    const topicId = (ctx.message as any)?.message_thread_id as number | undefined;
    const agentName = topicId ? getAgentByTopicId(topicId) || "general" : "general";

    const assetNote = asset ? `\n(asset: ${asset.id})` : "";
    const photoPrompt = `[Image attached: ${localPath}]${assetNote}\n\nUser says: ${caption}`;
    const tier = classifyComplexity(caption);
    let claudeResponse: string;

    if (tier !== "haiku") {
      // Complex task → streaming subprocess with live progress
      claudeResponse = await callClaudeWithProgress(ctx, photoPrompt, chatId, agentName, topicId);
    } else {
      // Simple task → standard subprocess (fast, no progress needed)
      claudeResponse = await callClaude(photoPrompt, chatId, agentName, topicId);
    }

    // Parse [ASSET_DESC] tag from response and update asset
    if (asset) {
      const parsed = parseAssetDescTag(claudeResponse);
      if (parsed) {
        updateAssetDescription(asset.id, parsed.description, parsed.tags).catch(
          (err) => console.error("Asset desc update error:", err)
        );
      } else {
        // Fallback: extract first 2 sentences from response
        const sentences = claudeResponse.match(/[^.!?]+[.!?]+/g);
        if (sentences && sentences.length > 0) {
          const fallbackDesc = sentences.slice(0, 2).join(" ").trim();
          updateAssetDescription(asset.id, fallbackDesc).catch(
            (err) => console.error("Asset desc update error:", err)
          );
        }
      }
    }

    // Strip [ASSET_DESC] tag before sending to user
    const cleanResponse = stripAssetDescTag(claudeResponse);

    // Persist bot response
    await saveMessage({
      chat_id: chatId,
      role: "assistant",
      content: cleanResponse,
      metadata: { type: "photo_reply", assetId: asset?.id },
    });

    await processIntents(cleanResponse);
    await sendResponse(ctx, cleanResponse);
  } catch (error) {
    console.error("Photo processing error:", error);
    await ctx.reply("Sorry, I couldn't process that image. Please try again.");
  } finally {
    typing.stop();
  }
}

// --- Document Messages ---

bot.on("message:document", (ctx) => {
  handleDocumentMessage(ctx).catch((err) => {
    console.error("Document handler error:", err);
  });
});

async function handleDocumentMessage(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id || "");
  const typing = createTypingIndicator(ctx);
  typing.start();

  try {
    const doc = ctx.message?.document;
    if (!doc) {
      await ctx.reply("Could not process document.");
      return;
    }

    const file = await ctx.api.getFile(doc.file_id);
    const filePath = file.file_path;
    if (!filePath) {
      await ctx.reply("Could not download document.");
      return;
    }

    const uploadsDir = join(PROJECT_ROOT, "uploads");
    await mkdir(uploadsDir, { recursive: true });

    const fileName = doc.file_name || `document_${Date.now()}`;
    const localPath = join(uploadsDir, fileName);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(localPath, buffer);

    const caption = ctx.message?.caption || `User sent a document: ${fileName}`;

    // Persist user message
    await saveMessage({
      chat_id: chatId,
      role: "user",
      content: `[Document: ${fileName}] ${caption}`,
      metadata: { type: "document", filePath: localPath, fileName },
    });

    // Process with Claude (uses same complexity-aware routing as text messages)
    const topicId = (ctx.message as any)?.message_thread_id as number | undefined;
    const agentName = topicId ? getAgentByTopicId(topicId) || "general" : "general";

    const docPrompt = `[User sent a document saved at: ${localPath}, filename: ${fileName}]\n\n${caption}`;
    const tier = classifyComplexity(caption);
    let claudeResponse: string;

    if (tier !== "haiku") {
      claudeResponse = await callClaudeWithProgress(ctx, docPrompt, chatId, agentName, topicId);
    } else {
      claudeResponse = await callClaude(docPrompt, chatId, agentName, topicId);
    }

    // Persist bot response
    await saveMessage({
      chat_id: chatId,
      role: "assistant",
      content: claudeResponse,
      metadata: { type: "document_reply" },
    });

    await processIntents(claudeResponse);
    await sendResponse(ctx, claudeResponse);
  } catch (error) {
    console.error("Document processing error:", error);
    await ctx.reply("Sorry, I couldn't process that document. Please try again.");
  } finally {
    typing.stop();
  }
}

// --- Callback Queries (Human-in-the-Loop Buttons) ---

bot.on("callback_query:data", (ctx) => {
  handleCallbackQuery(ctx).catch((err) => {
    console.error("Callback query error:", err);
  });
});

async function handleCallbackQuery(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  // Acknowledge the button press immediately
  await ctx.answerCallbackQuery().catch(() => {});

  // ---- Check-in button handlers ----

  if (data === "call_yes") {
    await ctx.editMessageText("📞 Calling you now...").catch(() => {});
    try {
      const { initiatePhoneCall } = await import("./lib/voice");
      const originalText = (ctx.callbackQuery.message as any)?.text || "";
      const context = originalText.replace(/^.*?about:\n\n/s, "").trim();
      await initiatePhoneCall(context || "Check-in call");
    } catch (err: any) {
      await ctx.editMessageText("Failed to initiate call: " + err.message).catch(() => {});
    }
    return;
  }

  if (data === "call_no" || data === "dismiss") {
    await ctx.editMessageText("✓").catch(() => {});
    return;
  }

  if (data === "snooze") {
    await ctx.editMessageText("😴 Snoozed for 30 minutes").catch(() => {});
    return;
  }

  if (data === "call_request") {
    await ctx.editMessageText("📞 Calling you now...").catch(() => {});
    try {
      const { initiatePhoneCall } = await import("./lib/voice");
      await initiatePhoneCall("You requested a call from the check-in");
    } catch (err: any) {
      await ctx.editMessageText("Failed to initiate call: " + err.message).catch(() => {});
    }
    return;
  }

  if (!data.startsWith("atask:")) return;

  const result = await handleTaskCallback(data);
  if (!result) {
    await ctx.editMessageText("Task not found or expired.").catch(() => {});
    return;
  }

  if (result.cancelled) {
    await ctx.editMessageText("Task cancelled.").catch(() => {});
    return;
  }

  const chatId = String(ctx.chat?.id || "");
  const task = result.task!;

  // Edit the button message to show the user's choice
  await ctx
    .editMessageText(
      `${task.pending_question || "Question"}\n\n✅ You chose: ${result.choice}`
    )
    .catch(() => {});

  // --- Agent SDK resume: task has session_id from Agent SDK ---
  if (task.metadata?.use_agent_sdk && task.metadata?.agent_sdk_session_id) {
    const typing = createTypingIndicator(ctx);
    typing.start();

    try {
      const agentResume: AgentResumeState = {
        taskId: result.taskId,
        sessionId: task.metadata.agent_sdk_session_id,
        userChoice: result.choice,
        originalPrompt: task.original_prompt,
      };

      const response = await processWithAgentSDK(
        task.original_prompt,
        chatId,
        ctx,
        agentResume
      );

      if (response) {
        await saveMessage({
          chat_id: chatId,
          role: "assistant",
          content: response,
          metadata: { type: "agent_sdk_resume", taskId: result.taskId },
        });
        await processIntents(response);
        await sendResponse(ctx, response);
      }

      await updateTask(result.taskId, {
        status: "completed",
        result: response ? response.substring(0, 10000) : "Continued in new task",
      });
    } catch (err) {
      console.error("Agent SDK resume error:", err);
      // Try fallback before giving up
      try {
        const fallbackResponse = await callFallbackLLM(task.original_prompt);
        await sendResponse(ctx, fallbackResponse);
      } catch {
        await ctx.reply("Error resuming task. Please try again.");
      }
      await updateTask(result.taskId, { status: "failed", result: String(err) });
    } finally {
      typing.stop();
    }
    return;
  }

  // --- VPS mode resume: task has messages_snapshot from Anthropic API ---
  if (task.metadata?.messages_snapshot) {
    const typing = createTypingIndicator(ctx);
    typing.start();

    try {
      const resumeState: ResumeState = {
        taskId: result.taskId,
        messagesSnapshot: task.metadata.messages_snapshot,
        assistantContent: task.metadata.assistant_content,
        userChoice: result.choice,
        toolUseId: task.metadata.tool_use_id,
      };

      const response = await processWithAnthropic(
        task.original_prompt,
        chatId,
        ctx,
        resumeState
      );

      // processWithAnthropic returns "" if another ask_user was triggered (new task created)
      if (response) {
        await saveMessage({
          chat_id: chatId,
          role: "assistant",
          content: response,
          metadata: { type: "task_resume", taskId: result.taskId },
        });
        await processIntents(response);
        await sendResponse(ctx, response);
      }

      // Mark the original task as completed (new task was created if another ask_user fired)
      await updateTask(result.taskId, {
        status: "completed",
        result: response ? response.substring(0, 10000) : "Continued in new task",
      });
    } catch (err) {
      console.error("VPS resume error:", err);
      // Try fallback before giving up
      try {
        const fallbackResponse = await callFallbackLLM(task.original_prompt);
        await sendResponse(ctx, fallbackResponse);
      } catch {
        await ctx.reply("Error resuming task. Please try again.");
      }
      await updateTask(result.taskId, { status: "failed", result: String(err) });
    } finally {
      typing.stop();
    }
    return;
  }

  // --- Mac mode resume: task has session_id from Claude Code subprocess ---
  if (task.session_id) {
    const typing = createTypingIndicator(ctx);
    typing.start();

    try {
      const claudeResult = await callClaudeSubprocess({
        prompt: `User responded: ${result.choice}`,
        outputFormat: "json",
        resumeSessionId: task.session_id,
        timeoutMs: 1_800_000,
        cwd: PROJECT_ROOT,
      });

      const response = claudeResult.text || "Task completed.";

      await saveMessage({
        chat_id: chatId,
        role: "assistant",
        content: response,
        metadata: { type: "task_resume", taskId: result.taskId },
      });
      await processIntents(response);

      // Check if the resumed response also contains questions
      const parsed = parseClaudeResponse(response);
      if (parsed.needsInput && parsed.options.length > 0) {
        await updateTask(result.taskId, {
          status: "needs_input",
          session_id: claudeResult.sessionId || task.session_id,
          pending_question: parsed.question || undefined,
          pending_options: parsed.options,
          current_step: parsed.text.substring(0, 500),
        });
        const keyboard = buildTaskKeyboard(result.taskId, parsed.options);
        await ctx
          .reply(response, { reply_markup: keyboard, parse_mode: "Markdown" })
          .catch(() => ctx.reply(response, { reply_markup: keyboard }));
      } else {
        await updateTask(result.taskId, {
          status: "completed",
          result: response.substring(0, 10000),
        });
        await sendResponse(ctx, response);
      }
    } catch (err) {
      console.error("Mac resume error:", err);
      await ctx.reply("Error resuming task. Please try again.");
      await updateTask(result.taskId, { status: "failed", result: String(err) });
    } finally {
      typing.stop();
    }
    return;
  }

  // --- No resume context: just acknowledge ---
  await ctx.reply(`Noted: ${result.choice}. Task marked complete.`);
  await updateTask(result.taskId, { status: "completed" });
}

// ---------------------------------------------------------------------------
// 8. callClaude() - Core AI Processing
// ---------------------------------------------------------------------------

/**
 * Call Claude Code subprocess with agent config, memory, and conversation context.
 * Claude Code has access to all configured MCP servers (Calendar, Gmail, Notion, etc.)
 * Falls back to secondary LLMs on error.
 */
async function callClaude(
  userMessage: string,
  chatId: string,
  agentName: string = "general",
  topicId?: number
): Promise<string> {
  const agentConfig = getAgentConfig(agentName);
  const userProfile = await getUserProfile();

  // Build memory context
  const memoryCtx = await getMemoryContext();

  // Build conversation context (recent messages)
  const conversationCtx = await getConversationContext(chatId, 10);

  // Current time in user's timezone
  const now = new Date().toLocaleString("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  // Build the full prompt
  const sections: string[] = [];

  // Agent system prompt (or default)
  if (agentConfig) {
    sections.push(agentConfig.systemPrompt);
  } else {
    sections.push("You are Go, a personal AI assistant. Be concise, direct, and helpful.");
  }

  // User profile context
  if (userProfile) {
    sections.push(`## USER PROFILE\n${userProfile}`);
  }

  // Time context
  sections.push(`## CURRENT TIME\n${now}`);

  // Memory context
  if (memoryCtx) {
    sections.push(`## MEMORY\n${memoryCtx}`);
  }

  // Recent conversation
  if (conversationCtx) {
    sections.push(`## RECENT CONVERSATION\n${conversationCtx}`);
  }

  // Session resumption note
  if (sessionState.sessionId) {
    sections.push(`## SESSION\nResuming session: ${sessionState.sessionId}`);
  }

  // Intent detection instructions
  sections.push(`## INTENT DETECTION
If the user sets a goal, include: [GOAL: description | DEADLINE: deadline]
If a goal is completed, include: [DONE: partial match]
If the user wants to cancel/abandon a goal, include: [CANCEL: partial match]
If you learn a fact worth remembering, include: [REMEMBER: fact]
If the user wants to forget a stored fact, include: [FORGET: partial match]
These tags will be parsed automatically. Include them naturally in your response.`);

  // Image cataloguing instructions
  sections.push(`## IMAGE CATALOGUING
When you analyze an image, include this tag at the END of your response:
[ASSET_DESC: concise 1-2 sentence description | tag1, tag2, tag3]
This is used for search/recall of images later. Be descriptive but concise.
Example: [ASSET_DESC: Birthday invitation with pink bunny holding a cupcake | birthday, invitation, kids]`);

  // The actual user message
  sections.push(`## USER MESSAGE\n${userMessage}`);

  const fullPrompt = sections.join("\n\n---\n\n");

  // Call Claude subprocess — read-only on external channels
  const result = await callClaudeSubprocess({
    prompt: fullPrompt,
    outputFormat: "json",
    allowedTools: READ_ONLY_TOOLS,
    resumeSessionId: sessionState.sessionId || undefined,
    timeoutMs: 1_800_000, // 30 minutes
    cwd: PROJECT_ROOT,
  });

  // Update session ID
  if (result.sessionId) {
    sessionState.sessionId = result.sessionId;
    await saveSessionState();
  }

  // Handle errors with fallback
  if (result.isError || !result.text) {
    console.error("Claude error, falling back to secondary LLM...");
    await sbLog("warn", "bot", "Claude failed, using fallback LLM", {
      error: result.text?.substring(0, 200),
    });

    try {
      const fallbackResponse = await callFallbackLLM(userMessage);
      return fallbackResponse;
    } catch (fallbackError) {
      console.error("Fallback LLM also failed:", fallbackError);
      return "I'm having trouble processing right now. Please try again in a moment.";
    }
  }

  return result.text;
}

/**
 * Full flow: call Claude, persist response, process intents, send reply.
 * Uses streaming subprocess for sonnet/opus tier (live progress updates).
 * Uses standard subprocess for haiku tier (fast, no progress needed).
 */
async function callClaudeAndReply(
  ctx: Context,
  chatId: string,
  userMessage: string,
  agentName: string,
  topicId?: number
): Promise<void> {
  const typing = createTypingIndicator(ctx);
  typing.start();

  try {
    const tier = classifyComplexity(userMessage);
    let response: string;

    if (tier !== "haiku") {
      // Complex task → streaming subprocess with live progress
      response = await callClaudeWithProgress(ctx, userMessage, chatId, agentName, topicId);
    } else {
      // Simple task → standard subprocess (fast, no progress needed)
      response = await callClaude(userMessage, chatId, agentName, topicId);
    }

    // Persist bot response
    await saveMessage({
      chat_id: chatId,
      role: "assistant",
      content: response,
      metadata: { agent: agentName, topicId },
    });

    // Process intents (goals, facts, etc.)
    await processIntents(response);

    // --- Cross-Agent Invocations ---
    const invocations = parseInvocationTags(response);
    if (invocations.length > 0) {
      // Send pre-invocation text (everything except the tags) via source agent
      const preText = stripInvocationTags(response);
      if (preText) {
        await botRegistry.sendAsAgent(agentName, chatId, preText, { threadId: topicId });
      }

      // Execute each invocation visibly
      for (const invocation of invocations) {
        await executeVisibleInvocation(
          botRegistry,
          agentName,
          invocation,
          chatId,
          topicId,
          callClaude
        );
      }
      return;
    }

    // Check if Claude is asking a question that needs inline button response
    const parsed = parseClaudeResponse(response);
    if (parsed.needsInput && parsed.options.length > 0) {
      // Create task for human-in-the-loop
      const task = await createTask(chatId, userMessage, topicId, "mac");
      if (task) {
        await updateTask(task.id, {
          status: "needs_input",
          session_id: sessionState.sessionId || undefined,
          pending_question: parsed.question || undefined,
          pending_options: parsed.options,
          current_step: parsed.text.substring(0, 500),
        });
        const keyboard = buildTaskKeyboard(task.id, parsed.options);
        await botRegistry.sendWithKeyboardAsAgent(agentName, chatId, response, keyboard, { threadId: topicId });
        return;
      }
    }

    // Normal response — send via agent's bot
    await botRegistry.sendAsAgent(agentName, chatId, response, { threadId: topicId });
  } catch (error) {
    console.error("callClaudeAndReply error:", error);
    await ctx.reply("Something went wrong. Please try again.");
  } finally {
    typing.stop();
  }
}

/**
 * Call Claude with streaming subprocess — sends live progress to Telegram.
 * Shows tool usage steps and first text snippet as the subprocess works.
 */
async function callClaudeWithProgress(
  ctx: Context,
  userMessage: string,
  chatId: string,
  agentName: string,
  topicId?: number
): Promise<string> {
  const agentConfig = getAgentConfig(agentName);
  const userProfile = await getUserProfile();
  const memoryCtx = await getMemoryContext();
  const conversationCtx = await getConversationContext(chatId, 10);

  const now = new Date().toLocaleString("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  // Build prompt (same as callClaude)
  const sections: string[] = [];
  if (agentConfig) {
    sections.push(agentConfig.systemPrompt);
  } else {
    sections.push("You are Go, a personal AI assistant. Be concise, direct, and helpful.");
  }
  if (userProfile) sections.push(`## USER PROFILE\n${userProfile}`);
  sections.push(`## CURRENT TIME\n${now}`);
  if (memoryCtx) sections.push(`## MEMORY\n${memoryCtx}`);
  if (conversationCtx) sections.push(`## RECENT CONVERSATION\n${conversationCtx}`);
  if (sessionState.sessionId) {
    sections.push(`## SESSION\nResuming session: ${sessionState.sessionId}`);
  }
  sections.push(`## INTENT DETECTION
If the user sets a goal, include: [GOAL: description | DEADLINE: deadline]
If a goal is completed, include: [DONE: partial match]
If the user wants to cancel/abandon a goal, include: [CANCEL: partial match]
If you learn a fact worth remembering, include: [REMEMBER: fact]
If the user wants to forget a stored fact, include: [FORGET: partial match]
These tags will be parsed automatically. Include them naturally in your response.`);
  sections.push(`## IMAGE CATALOGUING
When you analyze an image, include this tag at the END of your response:
[ASSET_DESC: concise 1-2 sentence description | tag1, tag2, tag3]
This is used for search/recall of images later. Be descriptive but concise.
Example: [ASSET_DESC: Birthday invitation with pink bunny holding a cupcake | birthday, invitation, kids]`);
  sections.push(`## USER MESSAGE\n${userMessage}`);

  const fullPrompt = sections.join("\n\n---\n\n");

  // Track progress message for editing
  let progressMsgId: number | undefined;
  let progressSteps: string[] = ["_Working on it..._"];

  // Helper to send or edit progress message
  const updateProgress = async (step: string) => {
    progressSteps.push(`→ ${step}`);
    const text = progressSteps.join("\n");
    try {
      if (!progressMsgId) {
        const msg = await ctx.reply(text, { parse_mode: "Markdown" });
        progressMsgId = msg.message_id;
      } else {
        await ctx.api.editMessageText(ctx.chat!.id, progressMsgId, text, {
          parse_mode: "Markdown",
        });
      }
    } catch {
      // Edit can fail if text is identical or message too old — ignore
    }
  };

  // Send initial progress
  try {
    const msg = await ctx.reply("_Working on it..._", { parse_mode: "Markdown" });
    progressMsgId = msg.message_id;
  } catch {}

  // Call streaming subprocess
  const result = await callClaudeStreaming({
    prompt: fullPrompt,
    allowedTools: READ_ONLY_TOOLS,
    resumeSessionId: sessionState.sessionId || undefined,
    timeoutMs: 1_800_000,
    cwd: PROJECT_ROOT,
    onToolStart: (toolName) => {
      updateProgress(toolName);
    },
    onFirstText: (snippet) => {
      // Show first sentence of Claude's thinking/plan
      const clean = snippet.replace(/[_*`]/g, "").substring(0, 120);
      if (clean.length > 20) {
        updateProgress(`_"${clean}..."_`);
      }
    },
  });

  // Delete progress message before sending final response
  if (progressMsgId) {
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, progressMsgId);
    } catch {
      // May fail if message is too old — that's fine
    }
  }

  // Update session ID
  if (result.sessionId) {
    sessionState.sessionId = result.sessionId;
    await saveSessionState();
  }

  // Handle errors with fallback
  if (result.isError || !result.text) {
    console.error("Claude streaming error, falling back to secondary LLM...");
    await sbLog("warn", "bot", "Claude streaming failed, using fallback LLM", {
      error: result.text?.substring(0, 200),
    });

    try {
      const fallbackResponse = await callFallbackLLM(userMessage);
      return fallbackResponse;
    } catch (fallbackError) {
      console.error("Fallback LLM also failed:", fallbackError);
      return "I'm having trouble processing right now. Please try again in a moment.";
    }
  }

  return result.text;
}

// ---------------------------------------------------------------------------
// Board Meeting — Multi-Bot Sequential Discussion
// ---------------------------------------------------------------------------

/**
 * Run a board meeting with each agent bot posting sequentially.
 * Orchestrator announces → each agent contributes → Orchestrator synthesizes.
 */
async function runBoardMeeting(
  chatId: string,
  topicId?: number,
  extraContext?: string
): Promise<void> {
  const boardAgents = ["research", "content", "finance", "strategy", "cto", "coo", "critic"];
  const contextNote = extraContext ? `\n\nAdditional context: ${extraContext}` : "";

  // Orchestrator announces
  await botRegistry.sendAsAgent(
    "general",
    chatId,
    `*Board Meeting Starting*\n\nGathering perspectives from all agents...${contextNote}`,
    { threadId: topicId }
  );

  // Gather live data in parallel with announcement
  const boardData = await gatherBoardData();
  console.log(`[BoardMeeting] Data gathered in ${boardData.fetchDurationMs}ms (errors: ${boardData.errors.join(", ") || "none"})`);

  const agentResponses: { agent: string; response: string }[] = [];

  // Each agent contributes sequentially
  for (const agent of boardAgents) {
    // Typing indicator from this agent's bot
    await botRegistry.sendTypingAsAgent(agent, chatId, topicId);

    // Build board prompt for this agent
    const previousInput = agentResponses
      .map((r) => `**${r.agent}**: ${r.response.substring(0, 300)}`)
      .join("\n\n");

    const dataBlock = boardData.agentData[agent] || "";
    const boardPrompt = `You are participating in a board meeting. Review recent activity and provide your specialized perspective.${contextNote}

${dataBlock}

${previousInput ? `## PREVIOUS AGENT INPUTS\n${previousInput}` : ""}

Reference specific numbers and data from your LIVE DATA section above. Provide a concise analysis from your domain. Focus on what matters most from your perspective. Keep it to 2-4 key points.`;

    try {
      const response = await callClaude(boardPrompt, chatId, agent, topicId);
      const cleanResponse = stripInvocationTags(response);
      agentResponses.push({ agent, response: cleanResponse });

      // Post via agent's bot
      await botRegistry.sendAsAgent(agent, chatId, cleanResponse, { threadId: topicId });

      // Brief pause for readability
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (err) {
      console.error(`[BoardMeeting] ${agent} failed:`, err);
      agentResponses.push({ agent, response: "(unavailable)" });
    }
  }

  // Orchestrator synthesizes
  await botRegistry.sendTypingAsAgent("general", chatId, topicId);

  const synthesisPrompt = `Board meeting synthesis requested. Here are all agent contributions:

${agentResponses.map((r) => `**${r.agent.toUpperCase()}**:\n${r.response}`).join("\n\n---\n\n")}

${boardData.sharedSummary ? `## CURRENT METRICS SNAPSHOT\n${boardData.sharedSummary}\n` : ""}
Synthesize the key themes, identify conflicts or alignments between agents, and propose 3-5 concrete action items with clear ownership. Ground your action items in the specific numbers above.`;

  const synthesis = await callClaude(synthesisPrompt, chatId, "general", topicId);
  await botRegistry.sendAsAgent("general", chatId, synthesis, { threadId: topicId });

  // Persist the full board meeting
  await saveMessage({
    chat_id: chatId,
    role: "assistant",
    content: `[Board Meeting]\n\n${agentResponses.map((r) => `${r.agent}: ${r.response}`).join("\n\n")}\n\n[Synthesis]\n${synthesis}`,
    metadata: { type: "board_meeting", topicId },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a display name from the user profile markdown.
 * Falls back to "User" if no name is found.
 */
function extractUserName(profile: string): string {
  if (!profile) return "User";
  // Try to find a name in common profile patterns
  const nameMatch = profile.match(/(?:^#\s+(.+)|name:\s*(.+)|Name:\s*(.+))/m);
  if (nameMatch) {
    return (nameMatch[1] || nameMatch[2] || nameMatch[3]).trim();
  }
  return "User";
}

// ---------------------------------------------------------------------------
// 9b. Async /process Background Handler
// ---------------------------------------------------------------------------

/**
 * Send a long response directly via bot.api (no Context needed).
 * Handles Telegram's 4096 char limit by chunking at paragraph boundaries.
 * Mirrors the logic in lib/telegram.ts sendResponse().
 */
async function sendDirectMessage(
  chatId: string | number,
  text: string,
  threadId?: number
): Promise<void> {
  // Convert standard markdown bold (**bold**) to Telegram markdown bold (*bold*)
  text = text.replace(/\*\*(.+?)\*\*/g, "*$1*");

  const MAX_LENGTH = 4000;
  const opts: Record<string, any> = {};
  if (threadId) opts.message_thread_id = threadId;

  if (text.length <= MAX_LENGTH) {
    await bot.api
      .sendMessage(chatId, text, { parse_mode: "Markdown", ...opts })
      .catch(() => bot.api.sendMessage(chatId, text, opts));
    return;
  }

  // Split at paragraph boundaries
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split("\n\n")) {
    if ((current + "\n\n" + paragraph).length > MAX_LENGTH) {
      if (current) chunks.push(current);
      current = paragraph;
    } else {
      current = current ? current + "\n\n" + paragraph : paragraph;
    }
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await bot.api
      .sendMessage(chatId, chunk, { parse_mode: "Markdown", ...opts })
      .catch(() => bot.api.sendMessage(chatId, chunk, opts));
  }
}

/**
 * Process a /process request in the background.
 * Sends typing indicator, calls Claude, and sends the response
 * directly to Telegram. Fire-and-forget from the HTTP handler.
 */
async function processInBackground(
  text: string | undefined,
  chatId: string | undefined,
  threadId: number | undefined,
  photoFileId: string | undefined
): Promise<void> {
  const targetChatId = chatId || "";
  if (!targetChatId) {
    console.error("/process background: no chatId provided");
    return;
  }

  // Send typing indicator
  await bot.api.sendChatAction(targetChatId, "typing").catch(() => {});

  // Keep typing indicator alive during processing
  const typingInterval = setInterval(() => {
    bot.api.sendChatAction(targetChatId, "typing").catch(() => {});
  }, 4000);

  try {
    let response: string;

    if (photoFileId) {
      // VPS forwarded a photo — download from Telegram and process
      const file = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${photoFileId}`
      ).then((r) => r.json()) as any;

      const filePath = file?.result?.file_path;
      if (!filePath) {
        await sendDirectMessage(targetChatId, "Could not download the photo from Telegram.", threadId);
        return;
      }

      const uploadsDir = join(PROJECT_ROOT, "uploads");
      await mkdir(uploadsDir, { recursive: true });

      const ext = filePath.split(".").pop() || "jpg";
      const localPath = join(uploadsDir, `photo_${Date.now()}.${ext}`);
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
      const dlRes = await fetch(fileUrl);
      const buffer = Buffer.from(await dlRes.arrayBuffer());
      await writeFile(localPath, buffer);

      // Upload to asset store
      const asset = await uploadAssetQuick(localPath, {
        userCaption: text || undefined,
        channel: "telegram",
        telegramFileId: photoFileId,
      });

      const caption = text || "User sent a photo. Describe and respond to it.";
      const assetNote = asset ? `\n(asset: ${asset.id})` : "";

      response = await callClaude(
        `[Image attached: ${localPath}]${assetNote}\n\nUser says: ${caption}`,
        targetChatId,
        "general",
        threadId
      );

      // Parse and update asset description
      if (asset) {
        const parsed = parseAssetDescTag(response);
        if (parsed) {
          updateAssetDescription(asset.id, parsed.description, parsed.tags).catch(() => {});
        } else {
          const sentences = response.match(/[^.!?]+[.!?]+/g);
          if (sentences) {
            updateAssetDescription(asset.id, sentences.slice(0, 2).join(" ").trim()).catch(() => {});
          }
        }
      }

      response = stripAssetDescTag(response);
    } else {
      // Text message
      response = await callClaude(text || "", targetChatId, "general", threadId);
    }

    // Send response directly to Telegram
    await sendDirectMessage(targetChatId, response, threadId);
    console.log(`/process completed for chat ${targetChatId} (${response.length} chars)`);
  } catch (err) {
    console.error("/process background processing error:", err);
    const errorMsg = "Sorry, something went wrong processing your message on the local machine.";
    await sendDirectMessage(targetChatId, errorMsg, threadId).catch(() => {});
  } finally {
    clearInterval(typingInterval);
  }
}

// ---------------------------------------------------------------------------
// 10. Health Check HTTP Server
// ---------------------------------------------------------------------------

const healthServer = Bun.serve({
  port: HEALTH_PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(
        JSON.stringify({
          status: "ok",
          service: "go-telegram-bot",
          uptime: process.uptime(),
          pid: process.pid,
          sessionId: sessionState.sessionId,
          timestamp: new Date().toISOString(),
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Process endpoint — VPS forwards messages here (async: returns 202 immediately)
    if (url.pathname === "/process" && req.method === "POST") {
      // Auth check
      if (GATEWAY_SECRET) {
        const auth = req.headers.get("authorization") || "";
        if (auth !== `Bearer ${GATEWAY_SECRET}`) {
          return new Response("Unauthorized", { status: 401 });
        }
      }

      let body: Record<string, any>;
      try {
        body = (await req.json()) as Record<string, any>;
      } catch (err: any) {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }

      const { text, chatId, threadId, photoFileId } = body;

      // Return 202 immediately — process in background
      processInBackground(text, chatId, threadId, photoFileId).catch((err) => {
        console.error("/process background error:", err);
      });

      return Response.json({ accepted: true }, { status: 202 });
    }

    return new Response("Not Found", { status: 404 });
  },
});

// ---------------------------------------------------------------------------
// 11. Bot Startup
// ---------------------------------------------------------------------------

// Initialize multi-bot agent identities (outbound-only, no polling)
await botRegistry.initialize();

console.log("=".repeat(50));
console.log("Go Telegram Bot - Starting");
console.log("=".repeat(50));
console.log(`PID:         ${process.pid}`);
console.log(`Project:     ${PROJECT_ROOT}`);
console.log(`Timezone:    ${TIMEZONE}`);
console.log(`Health:      http://localhost:${HEALTH_PORT}/health`);
console.log(`Claude:      ${CLAUDE_PATH}`);
console.log(`Voice:       ${isVoiceEnabled() ? "enabled" : "disabled"}`);
console.log(`Phone:       ${isCallEnabled() ? "enabled" : "disabled"}`);
console.log(`Transcribe:  ${isTranscriptionEnabled() ? "enabled" : "disabled"}`);
console.log(`Session:     ${sessionState.sessionId || "new"}`);
console.log(`HITL:        enabled (inline buttons + task queue)`);
console.log(`Routing:     model tier (haiku→instant, sonnet/opus→streaming progress)`);
console.log("=".repeat(50));

await sbLog("info", "bot", "Bot started", {
  pid: process.pid,
  timezone: TIMEZONE,
});

// Start polling
bot.start({
  onStart: (botInfo) => {
    console.log(`Bot online as @${botInfo.username}`);
  },
});
