/**
 * Go - Fallback LLM Chain with MCP Tool Access
 *
 * When Claude API fails or times out, fall back to:
 * 1. OpenRouter (cloud - any model) — skipped if FALLBACK_OFFLINE_ONLY=true
 * 2. Ollama (local)
 *
 * NEW: If MCPManager is active, fallback LLMs get full tool access
 * via OpenAI-compatible function calling. Email, calendar, Notion —
 * everything works regardless of which model responds.
 *
 * Set FALLBACK_OFFLINE_ONLY=true in .env to skip OpenRouter.
 */

import { mcpManager, type OpenAITool } from "./mcp-client";

const OPENROUTER_API_KEY = () => process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = () =>
  process.env.OPENROUTER_MODEL || "moonshotai/kimi-k2.5";
const OLLAMA_MODEL = () => process.env.OLLAMA_MODEL || "qwen3-coder";
const FALLBACK_OFFLINE_ONLY = () =>
  process.env.FALLBACK_OFFLINE_ONLY === "true";

export type FallbackSource = "openrouter" | "ollama" | "none";

export interface FallbackResult {
  text: string;
  source: FallbackSource;
}

/**
 * Try fallback LLMs and return response with source tag appended.
 * The tag tells the user which backend actually responded.
 */
export async function callFallbackLLM(prompt: string): Promise<string> {
  const result = await callFallbackLLMWithSource(prompt);
  if (result.source !== "none") {
    return `${result.text}\n\n_(responded via ${result.source})_`;
  }
  return result.text;
}

/**
 * Try fallback LLMs and return both the response text and which backend responded.
 */
export async function callFallbackLLMWithSource(
  prompt: string
): Promise<FallbackResult> {
  // Get MCP tools if available (OpenAI function calling format)
  const tools =
    mcpManager.isReady && mcpManager.toolCount > 0
      ? mcpManager.getOpenAITools()
      : undefined;

  if (tools) {
    console.log(
      `[Fallback] MCP tools available: ${mcpManager.toolCount} tools`
    );
  }

  // Tier 1: OpenRouter (cloud) — skip if FALLBACK_OFFLINE_ONLY is set
  if (OPENROUTER_API_KEY() && !FALLBACK_OFFLINE_ONLY()) {
    try {
      console.log(
        `🔄 Fallback: trying OpenRouter (${OPENROUTER_MODEL()})${tools ? ` with ${tools.length} tools` : ""}...`
      );

      const text = await callWithToolLoop(
        "https://openrouter.ai/api/v1/chat/completions",
        OPENROUTER_API_KEY(),
        OPENROUTER_MODEL(),
        prompt,
        tools,
        {
          "HTTP-Referer": "https://autonomee.ai",
          "X-Title": "GoBot",
        }
      );

      if (text) {
        console.log(`✅ OpenRouter responded (${OPENROUTER_MODEL()})`);
        return { text, source: "openrouter" };
      }
    } catch (err) {
      console.error("❌ OpenRouter failed:", err);
    }
  } else if (FALLBACK_OFFLINE_ONLY()) {
    console.log("⏭️ Skipping OpenRouter (FALLBACK_OFFLINE_ONLY=true)");
  }

  // Tier 2: Ollama (local) — OpenAI-compatible endpoint for tool calling
  try {
    console.log(
      `🔄 Fallback: trying Ollama (${OLLAMA_MODEL()})${tools ? ` with ${tools.length} tools` : ""}...`
    );

    const text = await callWithToolLoop(
      "http://localhost:11434/v1/chat/completions",
      "", // No auth for Ollama
      OLLAMA_MODEL(),
      prompt,
      tools
    );

    if (text) {
      console.log(`✅ Ollama responded (${OLLAMA_MODEL()})`);
      return { text, source: "ollama" };
    }
  } catch (err) {
    console.error("❌ Ollama failed (is it running?):", err);
  }

  return {
    text: "I'm having trouble connecting to all my backends right now. Please try again in a few minutes.",
    source: "none",
  };
}

// ============================================================
// TOOL CALLING LOOP — Works with any OpenAI-compatible API
// ============================================================

/**
 * Call an OpenAI-compatible API with optional function calling.
 * Handles the tool call loop: model requests tool → execute → feed result → repeat.
 */
async function callWithToolLoop(
  url: string,
  apiKey: string,
  model: string,
  prompt: string,
  tools?: OpenAITool[],
  extraHeaders?: Record<string, string>,
  maxIterations = 10
): Promise<string | null> {
  const userName = process.env.USER_NAME || "User";
  const userTimezone = process.env.USER_TIMEZONE || "UTC";
  const botName = process.env.BOT_NAME || "Go";

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

  const systemPrompt = `You are ${botName}, ${userName}'s AI assistant on Telegram.
Current time: ${localTime} (${userTimezone})
Processing: Fallback mode (primary AI unavailable)

${tools && tools.length > 0 ? `You have ${tools.length} tools available via MCP. Use them when the user asks to interact with external services (email, calendar, databases, etc.). Call tools as needed — you have full access.` : "You are in text-only mode. No external service access."}

Keep responses concise (Telegram-friendly). Be helpful with what you can do.`;

  const messages: any[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];

  for (let i = 0; i < maxIterations; i++) {
    const body: any = {
      model,
      messages,
      max_tokens: 4096,
    };

    // Only include tools if available and model might support them
    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...extraHeaders,
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000), // 60s timeout per call
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error(
        `[Fallback] API error ${response.status}: ${errText.substring(0, 200)}`
      );

      // If tools caused the error, retry without tools
      if (tools && tools.length > 0 && i === 0) {
        console.log("[Fallback] Retrying without tools...");
        return callWithToolLoop(
          url,
          apiKey,
          model,
          prompt,
          undefined,
          extraHeaders,
          1
        );
      }
      return null;
    }

    const data = (await response.json()) as any;
    const choice = data.choices?.[0];
    if (!choice) return null;

    const msg = choice.message;

    // No tool calls → return the text response
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // Some models put content in msg.content, others in msg.reasoning
      return msg.content || msg.reasoning || "";
    }

    // Tool calls requested — execute them and continue
    console.log(
      `[Fallback] Tool calls: ${msg.tool_calls.map((tc: any) => tc.function?.name).join(", ")}`
    );

    // Add assistant message with tool_calls to conversation
    messages.push(msg);

    // Execute each tool call
    for (const tc of msg.tool_calls) {
      const fnName = tc.function?.name;
      let fnArgs: Record<string, unknown> = {};

      try {
        fnArgs =
          typeof tc.function?.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : tc.function?.arguments || {};
      } catch {
        console.error(
          `[Fallback] Bad tool args for ${fnName}: ${tc.function?.arguments}`
        );
      }

      const result = await mcpManager.callTool(fnName, fnArgs);

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result.content.substring(0, 4000), // Truncate large results
      });
    }
  }

  console.log("[Fallback] Max tool iterations reached");
  return null;
}
