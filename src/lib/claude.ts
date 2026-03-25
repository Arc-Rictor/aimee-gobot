/**
 * Go - Claude Code Subprocess Spawner
 *
 * Spawns claude CLI as a subprocess for AI processing.
 * Handles session resumption, timeouts, cleanup, and streaming progress.
 */

import { spawn } from "bun";
import { optionalEnv } from "./env";

const IS_MACOS = process.platform === "darwin";
const IS_WINDOWS = process.platform === "win32";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "";
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "";

/**
 * Tool permission sets — centralized so every channel uses consistent access.
 *
 * READ_ONLY_TOOLS: Full device read access, no modifications.
 *   Use for external-facing channels (Discord, Telegram, VPS).
 *
 * WRITE_TOOLS: Additional tools that can modify files and run commands.
 *   Only granted to trusted internal channels (CLI/TUI, voice).
 *
 * ALL_TOOLS: READ_ONLY_TOOLS + WRITE_TOOLS combined.
 */
export const READ_ONLY_TOOLS = [
  "Read",       // Read any file on the device
  "Glob",       // Search for files by pattern
  "Grep",       // Search file contents
  "WebFetch",   // Fetch web content
  "WebSearch",  // Search the web
  "TodoRead",   // Read todos
];

export const WRITE_TOOLS = [
  "Write",      // Write files
  "Edit",       // Edit files
  "Bash",       // Shell commands
  "Skill",      // Claude Code skills
  "Task",       // Spawn sub-agents
  "TodoWrite",  // Write todos
];

export const ALL_TOOLS = [...READ_ONLY_TOOLS, ...WRITE_TOOLS];

export interface ClaudeOptions {
  prompt: string;
  outputFormat?: "json" | "text";
  allowedTools?: string[];
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "auto";
  resumeSessionId?: string;
  timeoutMs?: number;
  cwd?: string;
  maxTurns?: string;
}

export interface ClaudeStreamOptions extends ClaudeOptions {
  /** Called when a tool starts executing. Throttled to max 1 call per 5s. */
  onToolStart?: (toolName: string) => void;
  /** Called when the first meaningful text chunk arrives (plan/thinking). */
  onFirstText?: (snippet: string) => void;
}

export interface ClaudeResult {
  text: string;
  sessionId?: string;
  isError: boolean;
}

/**
 * Known error patterns in Claude output that indicate auth/API failures.
 */
export function isClaudeErrorResponse(text: string): boolean {
  const errorPatterns = [
    // API-level errors
    "authentication_error",
    "API Error: 401",
    "API Error: 403",
    "API Error: 429",
    "OAuth token has expired",
    "Failed to authenticate",
    "invalid_api_key",
    "overloaded_error",
    "rate_limit_error",
    "credit balance",
    "add funds",
    "billing",
    "insufficient_quota",
    "payment_required",
    // Subscription limit messages (Pro, Max, any tier)
    "hit your limit",
    "usage limit",
    "usage cap",
    "message limit",
    "reached your limit",
    "out of messages",
    "no messages remaining",
    "upgrade to",
    "exceeds your plan",
    "plan limit",
    "token limit reached",
    "conversation limit",
  ];
  const lower = text.toLowerCase();
  return errorPatterns.some((p) => lower.includes(p.toLowerCase()));
}

/**
 * Strip markdown code fences and extract JSON from Claude output.
 * Claude subprocesses often wrap JSON in ```json``` fences.
 */
export function extractJSON(output: string, key: string): any | null {
  const cleaned = output.replace(/```(?:json)?\s*/g, "").replace(/```/g, "");
  const jsonMatch = cleaned.match(
    new RegExp(`\\{[\\s\\S]*"${key}"[\\s\\S]*\\}`)
  );
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Build a clean env for Claude subprocesses.
 * Strips CLAUDECODE/CLAUDE_CODE_ENTRYPOINT to prevent "nested session" errors
 * when spawned from within a Claude Code session or PM2 that inherited those vars.
 */
function cleanEnvForClaude(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // Remove API key so Claude CLI uses subscription auth instead of pay-per-token
  delete env.ANTHROPIC_API_KEY;
  return {
    ...env,
    HOME: HOME_DIR,
    PATH: process.env.PATH || "",
  };
}

/**
 * Spawn a Claude Code subprocess with proper timeout and cleanup.
 */
export async function callClaude(options: ClaudeOptions): Promise<ClaudeResult> {
  const {
    prompt,
    outputFormat = "text",
    allowedTools,
    permissionMode,
    resumeSessionId,
    timeoutMs = 300_000, // 5 minutes default
    cwd,
    maxTurns,
  } = options;

  const args = ["-p", prompt, "--output-format", outputFormat];

  if (CLAUDE_MODEL) {
    args.push("--model", CLAUDE_MODEL);
  }

  if (permissionMode) {
    args.push("--permission-mode", permissionMode);
  }

  if (allowedTools && allowedTools.length > 0) {
    // --tools makes tools AVAILABLE, --allowedTools auto-approves them (no permission prompt)
    args.push("--tools", allowedTools.join(","));
    args.push("--allowedTools", allowedTools.join(","));
  }

  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  if (maxTurns) {
    args.push("--max-turns", maxTurns);
  }

  // On macOS, wrap with caffeinate -i to prevent idle sleep during active tasks
  const cmd = IS_MACOS
    ? ["/usr/bin/caffeinate", "-i", CLAUDE_PATH, ...args]
    : [CLAUDE_PATH, ...args];

  console.log(`[CLAUDE] Spawning subprocess (timeout: ${Math.round(timeoutMs / 1000)}s, resume: ${resumeSessionId || "none"}, tools: ${allowedTools?.join(",") || "default"}, permission: ${permissionMode || "default"})...`);
  console.log(`[CLAUDE] Full args: ${args.filter(a => a !== prompt).join(" ")}`);
  const startTime = Date.now();

  const proc = spawn({
    cmd,
    cwd: cwd || process.cwd(),
    env: cleanEnvForClaude(),
    stdout: "pipe",
    stderr: "pipe",
  });

  // Capture stderr for diagnostics
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");

  // Timeout with proper process kill
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    console.error(`[CLAUDE] Subprocess timed out after ${Math.round(timeoutMs / 1000)}s — killing`);
    try {
      proc.kill();
    } catch {}
  }, timeoutMs);

  try {
    const output = await new Response(proc.stdout).text();
    clearTimeout(timeoutId);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (timedOut) {
      console.error(`[CLAUDE] Subprocess killed after timeout (${elapsed}s)`);
      return { text: "", isError: true };
    }

    // Log stderr if present (auth errors, warnings, etc.)
    const stderr = await stderrPromise;
    if (stderr.trim()) {
      console.error(`[CLAUDE] Subprocess stderr (${elapsed}s):\n${stderr.substring(0, 500)}`);
    }

    // Check for empty output
    if (!output.trim()) {
      console.error(`[CLAUDE] Subprocess returned empty output (${elapsed}s)`);
      return { text: "", isError: true };
    }

    // Check for errors
    if (isClaudeErrorResponse(output)) {
      console.error(`[CLAUDE] Subprocess returned error response (${elapsed}s): ${output.substring(0, 200)}`);
      return { text: output, isError: true };
    }

    // Parse JSON output format
    if (outputFormat === "json") {
      try {
        const result = JSON.parse(output);
        // Trust the is_error field from Claude's JSON output.
        // Only fall back to pattern matching if is_error is not explicitly set.
        const isErr = result.is_error === true ||
          (result.is_error === undefined && isClaudeErrorResponse(result.result || ""));
        console.log(`[CLAUDE] Subprocess completed (${elapsed}s, session: ${result.session_id || "none"}, error: ${isErr})`);
        return {
          text: result.result || output,
          sessionId: result.session_id,
          isError: isErr,
        };
      } catch {
        console.error(`[CLAUDE] Failed to parse JSON output (${elapsed}s): ${output.substring(0, 200)}`);
        return { text: output, isError: isClaudeErrorResponse(output) };
      }
    }

    console.log(`[CLAUDE] Subprocess completed (${elapsed}s)`);
    return { text: output.trim(), isError: false };
  } catch (err) {
    clearTimeout(timeoutId);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`[CLAUDE] Subprocess exception (${elapsed}s):`, err);
    return { text: "", isError: true };
  }
}

/**
 * Run a Claude subprocess with timeout (simpler API for services).
 * Returns the raw output text. Kills process on timeout.
 */
export async function runClaudeWithTimeout(
  prompt: string,
  timeoutMs: number,
  options?: {
    allowedTools?: string[];
    cwd?: string;
  }
): Promise<string> {
  const baseCmd = [
    CLAUDE_PATH,
    "-p",
    prompt,
    "--output-format",
    "text",
    ...(options?.allowedTools
      ? ["--tools", options.allowedTools.join(","), "--allowedTools", options.allowedTools.join(",")]
      : []),
  ];
  const cmd = IS_MACOS
    ? ["/usr/bin/caffeinate", "-i", ...baseCmd]
    : baseCmd;

  const proc = spawn({
    cmd,
    cwd: options?.cwd || process.cwd(),
    env: cleanEnvForClaude(),
    stdout: "pipe",
    stderr: "pipe",
  });

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    try {
      proc.kill();
    } catch {}
  }, timeoutMs);

  try {
    const output = await new Response(proc.stdout).text();
    clearTimeout(timer);
    if (killed) throw new Error("Timeout");
    return output;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Friendly tool name mapping for progress updates
// ---------------------------------------------------------------------------

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  Read: "Reading file",
  Write: "Writing file",
  Edit: "Editing file",
  Glob: "Searching files",
  Grep: "Searching code",
  Bash: "Running command",
  WebSearch: "Searching the web",
  WebFetch: "Fetching page",
  Task: "Delegating task",
  AskUserQuestion: "Asking a question",
};

function friendlyToolName(toolName: string): string {
  // Direct match
  if (TOOL_DISPLAY_NAMES[toolName]) return TOOL_DISPLAY_NAMES[toolName];
  // MCP tool: mcp__server__action → "Using server"
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    const server = parts[1] || "tool";
    return `Using ${server.replace(/-/g, " ")}`;
  }
  return `Using ${toolName}`;
}

/**
 * Spawn Claude Code subprocess with streaming JSONL output.
 * Parses events in real time and fires callbacks for progress updates.
 * Returns the same ClaudeResult as callClaude() but with live progress.
 */
export async function callClaudeStreaming(options: ClaudeStreamOptions): Promise<ClaudeResult> {
  const {
    prompt,
    allowedTools,
    permissionMode,
    resumeSessionId,
    timeoutMs = 300_000,
    cwd,
    maxTurns,
    onToolStart,
    onFirstText,
  } = options;

  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];

  if (CLAUDE_MODEL) {
    args.push("--model", CLAUDE_MODEL);
  }

  if (permissionMode) {
    args.push("--permission-mode", permissionMode);
  }

  if (allowedTools && allowedTools.length > 0) {
    args.push("--tools", allowedTools.join(","));
    args.push("--allowedTools", allowedTools.join(","));
  }

  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  if (maxTurns) {
    args.push("--max-turns", maxTurns);
  }

  const cmd = IS_MACOS
    ? ["/usr/bin/caffeinate", "-i", CLAUDE_PATH, ...args]
    : [CLAUDE_PATH, ...args];

  const proc = spawn({
    cmd,
    cwd: cwd || process.cwd(),
    env: cleanEnvForClaude(),
    stdout: "pipe",
    stderr: "pipe",
  });

  // Timeout with proper process kill
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    console.error(`[CLAUDE] Streaming subprocess timed out after ${Math.round(timeoutMs / 1000)}s — killing`);
    try { proc.kill(); } catch {}
  }, timeoutMs);

  // Throttle tool progress (max 1 per 5s)
  let lastToolProgressAt = 0;
  const TOOL_THROTTLE_MS = 5_000;

  let sessionId: string | undefined;
  let resultText = "";
  let firstTextSent = false;
  let textAccumulator = "";

  try {
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of proc.stdout) {
      if (timedOut) break;

      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // skip malformed lines
        }

        // Capture session_id from any event that has it
        if (event.session_id && !sessionId) {
          sessionId = event.session_id;
        }

        // Final result event
        if (event.type === "result") {
          resultText = event.result || "";
          sessionId = event.session_id || sessionId;
          continue;
        }

        // Only process stream_event type
        if (event.type !== "stream_event") continue;

        const apiEvent = event.event;
        if (!apiEvent) continue;

        // Tool use start → progress callback
        if (
          apiEvent.type === "content_block_start" &&
          apiEvent.content_block?.type === "tool_use" &&
          onToolStart
        ) {
          const now = Date.now();
          if (now - lastToolProgressAt >= TOOL_THROTTLE_MS) {
            lastToolProgressAt = now;
            const name = apiEvent.content_block.name || "tool";
            onToolStart(friendlyToolName(name));
          }
        }

        // Text delta → accumulate for first-text callback
        if (
          apiEvent.type === "content_block_delta" &&
          apiEvent.delta?.type === "text_delta" &&
          apiEvent.delta.text
        ) {
          textAccumulator += apiEvent.delta.text;

          // Send first meaningful text snippet (>30 chars, first sentence)
          if (!firstTextSent && onFirstText && textAccumulator.length > 30) {
            firstTextSent = true;
            // Extract first sentence or first 150 chars
            const match = textAccumulator.match(/^.{30,150}?[.!?\n]/);
            const snippet = match ? match[0].trim() : textAccumulator.substring(0, 150).trim();
            onFirstText(snippet);
          }
        }
      }
    }

    clearTimeout(timeoutId);

    if (timedOut) {
      return { text: "", isError: true };
    }

    // If no result event (shouldn't happen), use accumulated text
    if (!resultText && textAccumulator) {
      resultText = textAccumulator;
    }

    if (isClaudeErrorResponse(resultText)) {
      return { text: resultText, sessionId, isError: true };
    }

    return { text: resultText, sessionId, isError: false };
  } catch {
    clearTimeout(timeoutId);
    return { text: "", isError: true };
  }
}
