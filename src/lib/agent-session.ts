/**
 * Agent Session — Claude Agent SDK Session Manager
 *
 * Provides full Claude Code capabilities on VPS via the Agent SDK:
 * MCP servers, skills, hooks, CLAUDE.md — all loaded from the user's
 * project settings via settingSources.
 *
 * Community version: no in-process MCP servers. Users configure their
 * own MCP servers in their Claude Code settings, and the Agent SDK
 * loads them automatically via settingSources: ["user", "project"].
 *
 * Full capabilities: Skills, hooks, CLAUDE.md, MCP servers, all built-in
 * tools — everything from Claude Code desktop, running on VPS.
 *
 * Usage: processWithAgentSDK(userMessage, chatId, ctx, resumeState?)
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { selectModelForMessage, toOpenRouterModel } from "./model-router";
import { AskUserSignal } from "./anthropic-processor";
import { buildTaskKeyboard } from "./task-queue";
import { callFallbackLLM } from "./fallback-llm";
import { READ_ONLY_TOOLS } from "./claude";
import {
  isAnthropicAvailable,
  markAnthropicDown,
  isCreditError,
  getOpenRouterEnv,
} from "./resilient-client";
import * as db from "./convex";
import type { Context } from "grammy";

// ============================================================
// TYPES
// ============================================================

/**
 * Resume state for continuing from ask_user pause via Agent SDK.
 * Uses session_id for resume instead of messages snapshot.
 */
export interface AgentResumeState {
  taskId: string;
  sessionId: string;
  userChoice: string;
  originalPrompt: string;
}

// ============================================================
// BUDGET TRACKING
// ============================================================

interface CostEntry {
  timestamp: number;
  costUSD: number;
  model: string;
  numTurns: number;
}

let dailyCosts: CostEntry[] = [];
let lastResetDate = new Date().toDateString();

export function getDailyBudgetRemaining(): number {
  const DAILY_BUDGET_USD = parseFloat(process.env.DAILY_API_BUDGET || "5.00");
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    if (dailyCosts.length > 0) {
      const totalSpent = dailyCosts.reduce((sum, e) => sum + e.costUSD, 0);
      console.log(
        `[COST] Daily reset — yesterday: ${dailyCosts.length} requests, $${totalSpent.toFixed(4)}`
      );
    }
    dailyCosts = [];
    lastResetDate = today;
  }
  const totalCost = dailyCosts.reduce((sum, e) => sum + e.costUSD, 0);
  return DAILY_BUDGET_USD - totalCost;
}

function trackCost(costUSD: number, model: string, numTurns: number): void {
  dailyCosts.push({
    timestamp: Date.now(),
    costUSD,
    model,
    numTurns,
  });
}

// ============================================================
// DYNAMIC CONTEXT
// ============================================================

function buildDynamicContext(): string {
  const userName = process.env.USER_NAME || "User";
  const userTimezone = process.env.USER_TIMEZONE || "UTC";

  const now = new Date();
  const localTime = now.toLocaleString("en-US", {
    timeZone: userTimezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return `
TELEGRAM CONTEXT:
You are responding via Telegram to ${userName}. Keep messages concise (max 2-3 short paragraphs).
Current time: ${localTime} (${userTimezone})

VOICE & STYLE:
- Direct, conversational, slightly casual. Never corporate or generic.
- Keep responses concise — this is Telegram, not an essay.
- No excessive emojis. One per message max, only if natural.

TOOL RULES:
- Use tools proactively — don't just describe what you could do, DO it.
- Use AskUserQuestion BEFORE taking irreversible actions.
- AskUserQuestion pauses the conversation and sends buttons to Telegram.

LIMITATIONS (CRITICAL):
- You CANNOT modify your own code, server, or configuration
- You CANNOT restart services, deploy updates, or fix bugs in yourself
- If something is broken, tell the user clearly — do NOT promise to fix it yourself
- Never say "I'll look into that", "Let me debug this", or "I'll fix that" about your own systems

INTENT DETECTION - Include at END of response when relevant:
- [GOAL: goal text | DEADLINE: optional]
- [DONE: what was completed] — ONLY when user explicitly states they finished something. Use the full goal text.
- [CANCEL: partial match]
- [REMEMBER: fact]
- [FORGET: partial match]`;
}

// ============================================================
// PROGRESS UPDATES
// ============================================================

async function sendProgress(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.reply(text, { parse_mode: "Markdown" });
  } catch {
    await ctx.reply(text).catch(() => {});
  }
}

// ============================================================
// MAIN PROCESSOR
// ============================================================

/**
 * Process a message using the Agent SDK.
 * Drop-in replacement for processWithAnthropic() on VPS.
 *
 * The Agent SDK spawns a Claude Code subprocess that loads:
 * - User's CLAUDE.md (project instructions)
 * - User's MCP servers (from Claude Code settings)
 * - User's skills and hooks
 * - Built-in tools (Read, Write, Bash, WebSearch, etc.)
 */
export async function processWithAgentSDK(
  userMessage: string,
  chatId: string,
  ctx: Context,
  resumeState?: AgentResumeState,
  onCallInitiated?: (conversationId: string) => void,
  retried: boolean = false
): Promise<string> {
  const startTime = Date.now();

  // Check daily budget
  const budgetRemaining = getDailyBudgetRemaining();
  if (budgetRemaining <= 0) {
    console.log(`[COST] Daily budget exceeded`);
    return "Daily API budget reached. I'll be back at full capacity tomorrow. For urgent requests, try again when the local machine is online.";
  }

  // Select model tier based on complexity
  const { tier, model: selectedModel } = selectModelForMessage(userMessage, budgetRemaining);
  const useOpenRouter = !isAnthropicAvailable() && !!process.env.OPENROUTER_API_KEY;
  const model = useOpenRouter ? toOpenRouterModel(selectedModel) : selectedModel;
  console.log(`[SDK] Model: ${tier.toUpperCase()} (${model})${useOpenRouter ? " [via OpenRouter]" : ""}`);

  // Load conversation context from Supabase
  let contextStr = "";
  try {
    const conversationHistory = await db.getConversationContext(
      chatId,
      10
    );
    const persistentMemory = await db.getMemoryContext();
    contextStr = persistentMemory + conversationHistory;
  } catch (err) {
    console.error("Failed to load conversation context:", err);
  }

  // Build the prompt
  let prompt: string;
  if (resumeState) {
    console.log(
      `[SDK] Resuming session ${resumeState.sessionId}: "${resumeState.userChoice}"`
    );
    prompt = `User chose: ${resumeState.userChoice}`;
  } else {
    prompt = userMessage;
    if (contextStr) {
      prompt = `[Previous conversation context]\n${contextStr}\n\n[Current message]\n${userMessage}`;
    }
  }

  // Build query options
  const options: Options = {
    model,
    maxTurns: 15,
    maxBudgetUsd: Math.min(budgetRemaining, 2.0),
    cwd: process.cwd(),
    executable: process.env.BUN_PATH || "bun",
    env: {
      ...process.env,
      ...(useOpenRouter
        ? getOpenRouterEnv()
        : { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "" }),
      HOME: process.env.HOME || "/root",
      // Ensure bun is in PATH for VPS environments
      PATH: `${process.env.HOME || "/root"}/.bun/bin:/usr/local/bin:/usr/bin:/bin`,
    } as Record<string, string>,
    stderr: (data: string) => {
      console.error(`[SDK:stderr] ${data.trim()}`);
    },
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: buildDynamicContext(),
    },
    // Load BOTH user (~/.claude/) and project settings — enables Skills, rules, CLAUDE.md
    settingSources: ["user", "project"],
    // Enable all Claude Code built-in tools INCLUDING Skill
    allowedTools: READ_ONLY_TOOLS,
    permissionMode: "acceptEdits",
    persistSession: true,
    thinking: tier === "opus" ? { type: "adaptive" } : { type: "disabled" },
    effort: tier === "haiku" ? "low" : tier === "sonnet" ? "medium" : "high",
    // Programmatic hooks — security guardrails for VPS
    hooks: {
      // Log all tool usage for observability
      PostToolUse: [
        {
          matcher: "*",
          hooks: [
            async (input: any) => {
              const toolName = input?.toolName || "unknown";
              const duration = input?.durationMs || 0;
              console.log(`[HOOK:PostToolUse] ${toolName} (${duration}ms)`);
              return {};
            },
          ],
        },
      ],
      // Security: block dangerous patterns
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            async (input: any) => {
              const cmd = (input?.input as any)?.command || "";
              // Block destructive commands on VPS
              const blocked = [
                /rm\s+-rf\s+\/(?!tmp)/,     // rm -rf / (except /tmp)
                /mkfs/,                       // format disk
                /dd\s+if=/,                   // disk write
                /iptables\s+-F/,             // flush firewall
                /systemctl\s+(stop|disable)\s+(docker|traefik|ssh)/,  // critical services
              ];
              for (const pattern of blocked) {
                if (pattern.test(cmd)) {
                  console.warn(`[HOOK:Security] BLOCKED: ${cmd}`);
                  return {
                    decision: "block" as const,
                    reason: `Blocked by security hook: destructive command pattern detected`,
                  };
                }
              }
              return {};
            },
          ],
        },
      ],
    },
    canUseTool: async (toolName, input) => {
      // Intercept AskUserQuestion — pause the agent loop for HITL
      if (toolName === "AskUserQuestion") {
        const inputObj = input as Record<string, any>;
        const questions = inputObj.questions || [];
        const firstQuestion = questions[0];
        const question = firstQuestion?.question || "Confirm?";
        const rawOptions = firstQuestion?.options || [];

        const options =
          rawOptions.length > 0
            ? rawOptions.map((opt: any) => ({
                label: opt.label || "Option",
                value: opt.label || "option",
              }))
            : [
                { label: "Yes, go ahead", value: "yes" },
                { label: "No, skip", value: "no" },
              ];

        throw new AskUserSignal(question, options, "", [], []);
      }

      // Allow everything else
      return { behavior: "allow" as const, updatedInput: input };
    },
  };

  // Resume existing session if available
  if (resumeState?.sessionId) {
    options.resume = resumeState.sessionId;
  }

  // Run the Agent SDK query with progress streaming
  let result = "";
  let sessionId = "";
  let totalCost = 0;
  let numTurns = 0;
  const enableProgress = tier !== "haiku";
  let sentPlan = false;

  try {
    for await (const message of query({ prompt, options })) {
      // Extract text from assistant messages
      if (message.type === "assistant") {
        let turnText = "";
        for (const block of message.message.content) {
          if ("text" in block && block.text) {
            turnText += block.text;
            result += block.text;
          }
        }
        sessionId = message.session_id;

        // Send first meaningful text as a progress update (skip for HITL resumes — user already saw "Got it: resuming...")
        if (enableProgress && !sentPlan && !resumeState && turnText.trim().length > 20) {
          const planPreview =
            turnText.length > 500
              ? turnText.substring(0, 500) + "..."
              : turnText;
          sendProgress(ctx, planPreview);
          sentPlan = true;
        }
      }

      // Extract session ID from system init
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        console.log(
          `[SDK] Session initialized: ${sessionId}, tools: ${message.tools?.length || 0}, mcp: ${message.mcp_servers?.length || 0}`
        );
      }

      // Handle result (success or error)
      if (message.type === "result") {
        sessionId = message.session_id;
        numTurns = message.num_turns;
        totalCost = message.total_cost_usd;

        if (message.subtype === "success") {
          if (message.result) {
            result = message.result;
          }
          console.log(
            `[SDK] Success: ${numTurns} turns, $${totalCost.toFixed(4)}, ${message.duration_ms}ms`
          );
        } else {
          console.error(
            `[SDK] Error (${message.subtype}): ${message.errors?.join(", ")}`
          );
          if (!result) {
            result = `Processing stopped: ${message.subtype}. ${message.errors?.[0] || ""}`;
          }
        }
      }
    }
  } catch (signal) {
    if (signal instanceof AskUserSignal) {
      // Pause execution — save state and send Telegram buttons
      const task = await db.createTask(
        chatId,
        userMessage || "resumed task",
        ctx.message?.message_thread_id,
        "vps"
      );

      if (task) {
        await db.updateTask(task.id, {
          status: "needs_input",
          pending_question: signal.question,
          pending_options: signal.options,
          current_step: `ask_user: ${signal.question}`,
          metadata: {
            agent_sdk_session_id: sessionId,
            use_agent_sdk: true,
          },
        });

        const keyboard = buildTaskKeyboard(task.id, signal.options);
        await ctx
          .reply(signal.question, {
            reply_markup: keyboard,
            parse_mode: "Markdown",
          })
          .catch(() =>
            ctx.reply(signal.question, { reply_markup: keyboard })
          );
      } else {
        return signal.question;
      }

      const elapsed = Date.now() - startTime;
      console.log(
        `[SDK] Paused (ask_user): ${elapsed}ms, session: ${sessionId}`
      );

      return "";
    }

    // Not an AskUserSignal — check if credit error for OpenRouter retry
    if (isCreditError(signal) && !useOpenRouter && process.env.OPENROUTER_API_KEY && !retried) {
      markAnthropicDown();
      console.log("[Resilient] Agent SDK credit error — retrying via OpenRouter...");
      return processWithAgentSDK(userMessage, chatId, ctx, resumeState, onCallInitiated, true);
    }

    // Try fallback LLMs before throwing
    console.error("Agent SDK error:", signal);
    console.log("🔄 VPS: Agent SDK failed, trying fallback LLMs...");
    try {
      const fallbackResponse = await callFallbackLLM(userMessage);
      return fallbackResponse;
    } catch (fallbackErr) {
      console.error("❌ Fallback also failed:", fallbackErr);
    }
    throw signal;
  }

  // Track cost
  if (totalCost > 0) {
    trackCost(totalCost, model, numTurns);
  }

  const elapsed = Date.now() - startTime;
  console.log(
    `[SDK] Complete: ${numTurns} turns, $${totalCost.toFixed(4)}, ${elapsed}ms, budget: $${getDailyBudgetRemaining().toFixed(2)}`
  );

  return result || "Processed but no response generated.";
}
