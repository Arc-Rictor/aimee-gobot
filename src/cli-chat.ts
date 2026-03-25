/**
 * Go - Terminal CLI Chat
 *
 * Interactive terminal chat interface that replaces Telegram.
 * Reuses the same Claude subprocess, memory, agents, and conversation
 * storage as the Telegram bot.
 *
 * Usage: bun run chat
 */

import { join } from "path";
import { createInterface } from "readline";

// ---------------------------------------------------------------------------
// Local Modules
// ---------------------------------------------------------------------------

import { loadEnv } from "./lib/env";
import { callClaude as callClaudeSubprocess, callClaudeStreaming, isClaudeErrorResponse, ALL_TOOLS } from "./lib/claude";
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
import { callFallbackLLM } from "./lib/fallback-llm";
import {
  saveMessage,
  getConversationContext,
  searchMessages,
  log as sbLog,
} from "./lib/convex";
import { classifyComplexity } from "./lib/model-router";
import {
  getAgentConfig,
  getUserProfile,
} from "./agents";

// ---------------------------------------------------------------------------
// 1. Load Environment
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();
await loadEnv(join(PROJECT_ROOT, ".env"));

const TIMEZONE = process.env.USER_TIMEZONE || "UTC";
const BOT_NAME = process.env.BOT_NAME || "Go";
const USER_NAME = process.env.USER_NAME || "User";
const CHAT_ID = "cli-chat"; // Virtual chat ID for storage

// ---------------------------------------------------------------------------
// 2. Session State
// ---------------------------------------------------------------------------

import { readFile, writeFile } from "fs/promises";

const SESSION_STATE_PATH = join(PROJECT_ROOT, "session-state-cli.json");

let sessionId: string | null = null;

async function loadSessionState(): Promise<void> {
  try {
    const raw = await readFile(SESSION_STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    sessionId = parsed.sessionId || null;
  } catch {
    // No saved state
  }
}

async function saveSessionState(): Promise<void> {
  try {
    await writeFile(SESSION_STATE_PATH, JSON.stringify({ sessionId }, null, 2), "utf-8");
  } catch {
    // Silent failure
  }
}

await loadSessionState();

// ---------------------------------------------------------------------------
// 3. Claude Processing (reused from bot.ts)
// ---------------------------------------------------------------------------

async function callClaude(
  userMessage: string,
  agentName: string = "general"
): Promise<string> {
  const agentConfig = getAgentConfig(agentName);
  const userProfile = await getUserProfile();
  const memoryCtx = await getMemoryContext();
  const conversationCtx = await getConversationContext(CHAT_ID, 10);

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

  const sections: string[] = [];

  if (agentConfig) {
    sections.push(agentConfig.systemPrompt);
  } else {
    sections.push(`You are ${BOT_NAME}, a personal AI assistant. Be concise, direct, and helpful.`);
  }

  if (userProfile) {
    sections.push(`## USER PROFILE\n${userProfile}`);
  }

  sections.push(`## CURRENT TIME\n${now}`);

  if (memoryCtx) {
    sections.push(`## MEMORY\n${memoryCtx}`);
  }

  if (conversationCtx) {
    sections.push(`## RECENT CONVERSATION\n${conversationCtx}`);
  }

  if (sessionId) {
    sections.push(`## SESSION\nResuming session: ${sessionId}`);
  }

  sections.push(`## FILESYSTEM ACCESS
You have FULL access to the entire device filesystem. You can:
- Read any file: use the Read tool with absolute paths (e.g., /home/aimee/somefile.txt)
- Search for files: use the Glob tool (e.g., pattern "**/*.md" in path "/home/aimee")
- Search file contents: use the Grep tool to find text across files
- Write and edit files: use the Write and Edit tools
- Run shell commands: use the Bash tool
- Fetch web pages: use WebFetch and WebSearch

This is a trusted internal channel. You have full read AND write access.
When asked to find, read, or modify something, always try using your tools first. Do not assume you lack access.

## OBSIDIAN VAULT
You have an Obsidian vault at obsidian/ (relative to your working directory).
Folders: Reflections/ (nightly journal entries), Board/, Briefings/, Daily/, Knowledge/.
You can read, write, and edit anything in it freely.`);

  sections.push(`## INTENT DETECTION
If the user sets a goal, include: [GOAL: description | DEADLINE: deadline]
If a goal is completed, include: [DONE: partial match]
If the user wants to cancel/abandon a goal, include: [CANCEL: partial match]
If you learn a fact worth remembering, include: [REMEMBER: fact]
If the user wants to forget a stored fact, include: [FORGET: partial match]
These tags will be parsed automatically. Include them naturally in your response.`);

  sections.push(`## USER MESSAGE\n${userMessage}`);

  const fullPrompt = sections.join("\n\n---\n\n");

  const result = await callClaudeSubprocess({
    prompt: fullPrompt,
    outputFormat: "json",
    allowedTools: ALL_TOOLS,
    resumeSessionId: sessionId || undefined,
    timeoutMs: 1_800_000,
    cwd: PROJECT_ROOT,
  });

  if (result.sessionId) {
    sessionId = result.sessionId;
    await saveSessionState();
  }

  if (result.isError || !result.text) {
    console.error("\x1b[33m⚠ Claude error, trying fallback LLM...\x1b[0m");
    try {
      return await callFallbackLLM(userMessage);
    } catch {
      return "I'm having trouble processing right now. Please try again.";
    }
  }

  return result.text;
}

async function callClaudeWithProgress(
  userMessage: string,
  agentName: string = "general"
): Promise<string> {
  const agentConfig = getAgentConfig(agentName);
  const userProfile = await getUserProfile();
  const memoryCtx = await getMemoryContext();
  const conversationCtx = await getConversationContext(CHAT_ID, 10);

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
  sections.push(`## FILESYSTEM ACCESS
You have FULL access to the entire device filesystem. You can:
- Read any file: use the Read tool with absolute paths (e.g., /home/aimee/somefile.txt)
- Search for files: use the Glob tool (e.g., pattern "**/*.md" in path "/home/aimee")
- Search file contents: use the Grep tool to find text across files
- Write and edit files: use the Write and Edit tools
- Run shell commands: use the Bash tool
- Fetch web pages: use WebFetch and WebSearch

This is a trusted internal channel. You have full read AND write access.
When asked to find, read, or modify something, always try using your tools first. Do not assume you lack access.

## OBSIDIAN VAULT
You have an Obsidian vault at obsidian/ (relative to your working directory).
Folders: Reflections/ (nightly journal entries), Board/, Briefings/, Daily/, Knowledge/.
You can read, write, and edit anything in it freely.`);
  sections.push(`## INTENT DETECTION
If the user sets a goal, include: [GOAL: description | DEADLINE: deadline]
If a goal is completed, include: [DONE: partial match]
If the user wants to cancel/abandon a goal, include: [CANCEL: partial match]
If you learn a fact worth remembering, include: [REMEMBER: fact]
If the user wants to forget a stored fact, include: [FORGET: partial match]
These tags will be parsed automatically. Include them naturally in your response.`);
  sections.push(`## USER MESSAGE\n${userMessage}`);

  const fullPrompt = sections.join("\n\n---\n\n");

  const result = await callClaudeStreaming({
    prompt: fullPrompt,
    allowedTools: ALL_TOOLS,
    resumeSessionId: sessionId || undefined,
    timeoutMs: 1_800_000,
    cwd: PROJECT_ROOT,
    onToolStart: (toolName) => {
      process.stdout.write(`\x1b[90m  ⚙ ${toolName}...\x1b[0m\n`);
    },
    onFirstText: (snippet) => {
      process.stdout.write(`\x1b[90m  💭 ${snippet}\x1b[0m\n`);
    },
  });

  if (result.sessionId) {
    sessionId = result.sessionId;
    await saveSessionState();
  }

  if (result.isError || !result.text) {
    console.error("\x1b[33m⚠ Claude error, trying fallback LLM...\x1b[0m");
    try {
      return await callFallbackLLM(userMessage);
    } catch {
      return "I'm having trouble processing right now. Please try again.";
    }
  }

  return result.text;
}

// ---------------------------------------------------------------------------
// 4. Memory Command Handlers (inline, no Telegram)
// ---------------------------------------------------------------------------

async function handleMemoryCommand(text: string): Promise<string | null> {
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
    const goals = await listGoals();
    return `Active Goals:\n${goals}`;
  }

  if (lower === "memory" || lower === "facts" || lower === "/memory") {
    const facts = await listFacts();
    return `Stored Facts:\n${facts}`;
  }

  if (lower.startsWith("recall ") || lower.startsWith("search ") || lower.startsWith("find ")) {
    const query = text.split(/\s+/).slice(1).join(" ");
    if (query) {
      const results = await searchMessages(CHAT_ID, query, 5);
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

  return null; // Not a memory command
}

// ---------------------------------------------------------------------------
// 5. Main Chat Loop
// ---------------------------------------------------------------------------

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(): void {
  rl.question(`\x1b[36m${USER_NAME}\x1b[0m > `, async (input) => {
    const text = input.trim();

    if (!text) {
      prompt();
      return;
    }

    // Exit commands
    if (text === "/quit" || text === "/exit" || text === "quit" || text === "exit") {
      console.log(`\x1b[90m${BOT_NAME} signing off. See you!\x1b[0m`);
      rl.close();
      process.exit(0);
    }

    // Help
    if (text === "/help" || text === "help") {
      console.log(`
\x1b[1m${BOT_NAME} — CLI Chat\x1b[0m

\x1b[4mCommands:\x1b[0m
  remember: <fact>          Save a fact to memory
  track: <goal>             Track a goal (add | deadline: date)
  done: <goal>              Mark a goal as complete
  forget: <fact>            Remove a stored fact
  cancel: <goal>            Cancel/remove a goal
  goals                     List active goals
  memory / facts            List stored facts
  recall/search/find <q>    Search conversation history
  /agent <name>             Switch agent (general, research, content, finance, strategy, critic)
  /quit                     Exit

\x1b[4mOtherwise, just type your message.\x1b[0m
`);
      prompt();
      return;
    }

    // Agent switch
    if (text.startsWith("/agent ")) {
      const name = text.slice("/agent ".length).trim().toLowerCase();
      const config = getAgentConfig(name);
      if (config) {
        currentAgent = name;
        console.log(`\x1b[90mSwitched to \x1b[1m${config.name}\x1b[0m\x1b[90m agent.\x1b[0m`);
      } else {
        console.log(`\x1b[31mUnknown agent "${name}". Available: general, research, content, finance, strategy, critic\x1b[0m`);
      }
      prompt();
      return;
    }

    // Memory commands
    const memoryResult = await handleMemoryCommand(text);
    if (memoryResult !== null) {
      console.log(`\x1b[32m${BOT_NAME}\x1b[0m > ${memoryResult}`);
      prompt();
      return;
    }

    // Save user message
    await saveMessage({
      chat_id: CHAT_ID,
      role: "user",
      content: text,
      metadata: { source: "cli" },
    });

    // Show thinking indicator
    process.stdout.write(`\x1b[90m${BOT_NAME} is thinking...\x1b[0m\n`);

    try {
      // Route by complexity
      const tier = classifyComplexity(text);
      let response: string;

      if (tier !== "haiku") {
        response = await callClaudeWithProgress(text, currentAgent);
      } else {
        response = await callClaude(text, currentAgent);
      }

      // Save assistant message
      await saveMessage({
        chat_id: CHAT_ID,
        role: "assistant",
        content: response,
        metadata: { agent: currentAgent, source: "cli" },
      });

      // Process intents (goals, facts, etc.)
      await processIntents(response);

      // Print response
      console.log(`\n\x1b[32m${BOT_NAME}\x1b[0m > ${response}\n`);
    } catch (err) {
      console.error(`\x1b[31mError: ${err}\x1b[0m`);
    }

    prompt();
  });
}

// ---------------------------------------------------------------------------
// 6. Startup
// ---------------------------------------------------------------------------

let currentAgent = "general";

console.log(`
\x1b[1m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
  \x1b[1m${BOT_NAME}\x1b[0m — Terminal Chat
  Type \x1b[36m/help\x1b[0m for commands, \x1b[36m/quit\x1b[0m to exit
\x1b[1m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
`);

prompt();
