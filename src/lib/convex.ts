/**
 * Convex Client Module
 *
 * Drop-in replacement for supabase.ts. Same exported function signatures.
 * Uses ConvexHttpClient for server-side operations.
 *
 * Tiered fallback:
 *   1. CONVEX_URL set → use Convex
 *   2. SUPABASE_URL set → use Supabase
 *   3. Neither → local JSON files (handled by memory.ts)
 */

import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

// ---------------------------------------------------------------------------
// Types (same as supabase.ts)
// ---------------------------------------------------------------------------

export interface Message {
  id?: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface MemoryItem {
  id?: string;
  type: "fact" | "goal";
  content: string;
  deadline?: string;
  completed?: boolean;
  completed_at?: string;
  created_at?: string;
}

export interface LogEntry {
  id?: string;
  level: "info" | "warn" | "error" | "debug";
  service: string;
  message: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface AsyncTask {
  id: string;
  created_at: string;
  updated_at: string;
  chat_id: string;
  original_prompt: string;
  status: "pending" | "running" | "needs_input" | "completed" | "failed";
  result?: string;
  session_id?: string;
  current_step?: string;
  pending_question?: string;
  pending_options?: { label: string; value: string }[];
  user_response?: string;
  thread_id?: number;
  processed_by?: string;
  reminder_sent?: boolean;
  metadata?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Singleton Client
// ---------------------------------------------------------------------------

let convexClient: ConvexHttpClient | null = null;
let supabaseClient: any = null;

// Lazy import supabase only if needed (fallback)
async function getSupabaseFallback() {
  if (supabaseClient !== undefined) return supabaseClient;
  try {
    const mod = await import("./supabase");
    supabaseClient = mod.getSupabase();
    return supabaseClient;
  } catch {
    supabaseClient = null;
    return null;
  }
}

/**
 * Get or create the singleton Convex client.
 * Returns null if CONVEX_URL is not set.
 */
export function getConvex(): ConvexHttpClient | null {
  if (convexClient) return convexClient;

  const url = process.env.CONVEX_URL;
  if (!url) return null;

  convexClient = new ConvexHttpClient(url);
  return convexClient;
}

/**
 * Whether Convex (or Supabase fallback) is configured and available.
 */
export function isConvexEnabled(): boolean {
  return !!process.env.CONVEX_URL || !!process.env.SUPABASE_URL;
}

// Backward-compat aliases
export const getSupabase = getConvex;
export const isSupabaseEnabled = isConvexEnabled;

/**
 * Determine which backend is active.
 */
function getBackend(): "convex" | "supabase" | "none" {
  if (process.env.CONVEX_URL) return "convex";
  if (process.env.SUPABASE_URL) return "supabase";
  return "none";
}

// ---------------------------------------------------------------------------
// Helpers (same as supabase.ts)
// ---------------------------------------------------------------------------

/**
 * Human-readable relative time (e.g. "2 minutes ago", "1 hour ago").
 */
export function getTimeAgo(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  if (diffHour < 24)
    return `${diffHour} hour${diffHour === 1 ? "" : "s"} ago`;
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  return date.toLocaleDateString();
}

/**
 * Parse natural-language relative dates into ISO strings.
 */
export function parseRelativeDate(input: string): string | undefined {
  if (!input) return undefined;

  const lower = input.trim().toLowerCase();
  const now = new Date();

  if (lower === "today") {
    now.setHours(23, 59, 59, 0);
    return now.toISOString();
  }

  if (lower === "tomorrow") {
    now.setDate(now.getDate() + 1);
    now.setHours(23, 59, 59, 0);
    return now.toISOString();
  }

  const inDays = lower.match(/^in\s+(\d+)\s+days?$/);
  if (inDays) {
    now.setDate(now.getDate() + parseInt(inDays[1], 10));
    now.setHours(23, 59, 59, 0);
    return now.toISOString();
  }

  const inHours = lower.match(/^in\s+(\d+)\s+hours?$/);
  if (inHours) {
    now.setHours(now.getHours() + parseInt(inHours[1], 10));
    return now.toISOString();
  }

  const inWeeks = lower.match(/^in\s+(\d+)\s+weeks?$/);
  if (inWeeks) {
    now.setDate(now.getDate() + parseInt(inWeeks[1], 10) * 7);
    now.setHours(23, 59, 59, 0);
    return now.toISOString();
  }

  const timeMatch = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const meridiem = timeMatch[3];

    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;

    now.setHours(hours, minutes, 0, 0);
    if (now.getTime() < Date.now()) {
      now.setDate(now.getDate() + 1);
    }
    return now.toISOString();
  }

  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Internal: Convert Convex response to common format
// ---------------------------------------------------------------------------

function convexToMessage(doc: any): Message {
  return {
    id: doc._id,
    chat_id: doc.chatId,
    role: doc.role,
    content: doc.content,
    metadata: doc.metadata,
    created_at: doc.createdAt
      ? new Date(doc.createdAt).toISOString()
      : undefined,
  };
}

function convexToMemoryItem(doc: any): MemoryItem {
  return {
    id: doc._id,
    type: doc.type,
    content: doc.content,
    deadline: doc.deadline ? new Date(doc.deadline).toISOString() : undefined,
    completed: doc.completed,
    completed_at: doc.completedAt
      ? new Date(doc.completedAt).toISOString()
      : undefined,
    created_at: doc.createdAt
      ? new Date(doc.createdAt).toISOString()
      : undefined,
  };
}

function convexToAsyncTask(doc: any): AsyncTask {
  return {
    id: doc._id,
    created_at: doc.createdAt
      ? new Date(doc.createdAt).toISOString()
      : new Date().toISOString(),
    updated_at: doc.updatedAt
      ? new Date(doc.updatedAt).toISOString()
      : new Date().toISOString(),
    chat_id: doc.chatId,
    original_prompt: doc.originalPrompt,
    status: doc.status,
    result: doc.result,
    session_id: doc.sessionId,
    current_step: doc.currentStep,
    pending_question: doc.pendingQuestion,
    pending_options: doc.pendingOptions,
    user_response: doc.userResponse,
    thread_id: doc.threadId,
    processed_by: doc.processedBy,
    reminder_sent: doc.reminderSent,
    metadata: doc.metadata,
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Save a message. Generates embedding async via Convex action.
 */
export async function saveMessage(message: Message): Promise<boolean> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      await client.mutation(anyApi.messages.insert, {
        chatId: message.chat_id,
        role: message.role,
        content: message.content,
        metadata: message.metadata || {},
        createdAt: Date.now(),
      });
      return true;
    } catch (err) {
      console.error("Convex saveMessage error:", err);
      return false;
    }
  }

  if (backend === "supabase") {
    const { saveMessage: sbSave } = await import("./supabase");
    return sbSave(message);
  }

  return false;
}

/**
 * Retrieve the N most recent messages for a chat, ordered chronologically.
 */
export async function getRecentMessages(
  chatId: string,
  limit: number = 20
): Promise<Message[]> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const docs = await client.query(anyApi.messages.getRecent, {
        chatId,
        limit,
      });
      return (docs || []).map(convexToMessage);
    } catch {
      return [];
    }
  }

  if (backend === "supabase") {
    const { getRecentMessages: sbGet } = await import("./supabase");
    return sbGet(chatId, limit);
  }

  return [];
}

/**
 * Build a formatted conversation context string from recent messages.
 */
export async function getConversationContext(
  chatId: string,
  limit: number = 10
): Promise<string> {
  const messages = await getRecentMessages(chatId, limit);
  if (messages.length === 0) return "";

  return messages
    .map((msg) => {
      const time = msg.created_at ? getTimeAgo(new Date(msg.created_at)) : "";
      const speaker = msg.role === "user" ? "User" : "Bot";
      return `[${time}] ${speaker}: ${msg.content}`;
    })
    .join("\n");
}

/**
 * Get recent messages across all channels/topics for board meeting context.
 */
export async function getBoardMeetingContext(
  days: number = 7
): Promise<string> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const result = await client.query(
        anyApi.messages.getBoardMeetingContext,
        { days }
      );
      return result || "\n\nNo recent conversations across topics.";
    } catch {
      return "\n\nFailed to load conversation context.";
    }
  }

  if (backend === "supabase") {
    const { getBoardMeetingContext: sbGet } = await import("./supabase");
    return sbGet(days);
  }

  return "\n\nNo conversation data available.";
}

/**
 * Semantic search across messages.
 * Falls back to text search when semantic search is unavailable.
 */
export async function searchMessages(
  chatId: string,
  query: string,
  limit: number = 10
): Promise<Message[]> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const docs = await client.query(anyApi.messages.textSearch, {
        chatId,
        query,
        limit,
      });
      return (docs || []).map(convexToMessage);
    } catch {
      return [];
    }
  }

  if (backend === "supabase") {
    const { searchMessages: sbSearch } = await import("./supabase");
    return sbSearch(chatId, query, limit);
  }

  return [];
}

// ---------------------------------------------------------------------------
// Memory: Facts
// ---------------------------------------------------------------------------

/**
 * Store a fact in the memory table.
 */
export async function addFact(content: string): Promise<boolean> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      await client.mutation(anyApi.memory.addFact, { content });
      return true;
    } catch {
      return false;
    }
  }

  if (backend === "supabase") {
    const { addFact: sbAdd } = await import("./supabase");
    return sbAdd(content);
  }

  return false;
}

/**
 * Retrieve all stored facts.
 */
export async function getFacts(): Promise<MemoryItem[]> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const docs = await client.query(anyApi.memory.getFacts, {});
      return (docs || []).map(convexToMemoryItem);
    } catch {
      return [];
    }
  }

  if (backend === "supabase") {
    const { getFacts: sbGet } = await import("./supabase");
    return sbGet();
  }

  return [];
}

// ---------------------------------------------------------------------------
// Memory: Goals
// ---------------------------------------------------------------------------

/**
 * Add a goal, optionally with a deadline (natural language or ISO).
 */
export async function addGoal(
  content: string,
  deadline?: string
): Promise<boolean> {
  const backend = getBackend();
  const parsedDeadline = deadline ? parseRelativeDate(deadline) : undefined;

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      await client.mutation(anyApi.memory.addGoal, {
        content,
        deadline: parsedDeadline
          ? new Date(parsedDeadline).getTime()
          : undefined,
      });
      return true;
    } catch {
      return false;
    }
  }

  if (backend === "supabase") {
    const { addGoal: sbAdd } = await import("./supabase");
    return sbAdd(content, deadline);
  }

  return false;
}

/**
 * Mark a goal as completed by partial text match.
 */
export async function completeGoal(searchText: string): Promise<boolean> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const result = await client.mutation(anyApi.memory.completeGoal, {
        searchText,
      });
      return !!result;
    } catch {
      return false;
    }
  }

  if (backend === "supabase") {
    const { completeGoal: sbComplete } = await import("./supabase");
    return sbComplete(searchText);
  }

  return false;
}

/**
 * Delete a fact by partial text match.
 */
export async function deleteFact(searchText: string): Promise<boolean> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const result = await client.mutation(anyApi.memory.deleteFact, {
        searchText,
      });
      return !!result;
    } catch {
      return false;
    }
  }

  if (backend === "supabase") {
    const { deleteFact: sbDelete } = await import("./supabase");
    return sbDelete(searchText);
  }

  return false;
}

/**
 * Cancel (delete) a goal by partial text match.
 */
export async function cancelGoal(searchText: string): Promise<boolean> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const result = await client.mutation(anyApi.memory.cancelGoal, {
        searchText,
      });
      return !!result;
    } catch {
      return false;
    }
  }

  if (backend === "supabase") {
    const { cancelGoal: sbCancel } = await import("./supabase");
    return sbCancel(searchText);
  }

  return false;
}

/**
 * Get all active (incomplete) goals.
 */
export async function getActiveGoals(): Promise<MemoryItem[]> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const docs = await client.query(anyApi.memory.getActiveGoals, {});
      return (docs || []).map(convexToMemoryItem);
    } catch {
      return [];
    }
  }

  if (backend === "supabase") {
    const { getActiveGoals: sbGet } = await import("./supabase");
    return sbGet();
  }

  return [];
}

// ---------------------------------------------------------------------------
// Memory Context
// ---------------------------------------------------------------------------

/**
 * Format goals into a readable list.
 */
export function formatGoalsList(goals: MemoryItem[]): string {
  if (goals.length === 0) return "No active goals.";
  return goals
    .map((g, i) => {
      const deadline = g.deadline
        ? ` (due: ${new Date(g.deadline).toLocaleDateString()})`
        : "";
      return `${i + 1}. ${g.content}${deadline}`;
    })
    .join("\n");
}

/**
 * Format facts into a readable list.
 */
export function formatFactsList(facts: MemoryItem[]): string {
  if (facts.length === 0) return "No stored facts.";
  return facts.map((f) => `- ${f.content}`).join("\n");
}

/**
 * Build a combined memory context string with facts and goals.
 */
export async function getMemoryContext(): Promise<string> {
  const [facts, goals] = await Promise.all([getFacts(), getActiveGoals()]);

  const sections: string[] = [];

  if (facts.length > 0) {
    sections.push(`**Known Facts:**\n${formatFactsList(facts)}`);
  }

  if (goals.length > 0) {
    sections.push(`**Active Goals:**\n${formatGoalsList(goals)}`);
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Write a log entry. Fails silently.
 */
export async function log(
  level: LogEntry["level"],
  service: string,
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      await client.mutation(anyApi.logs.insert, {
        level,
        service,
        message,
        metadata: metadata || {},
        createdAt: Date.now(),
      });
    } catch {
      // Logging should never throw
    }
    return;
  }

  if (backend === "supabase") {
    const { log: sbLog } = await import("./supabase");
    return sbLog(level, service, message, metadata);
  }
}

// ---------------------------------------------------------------------------
// Async Tasks (Human-in-the-Loop)
// ---------------------------------------------------------------------------

/**
 * Create a new async task.
 */
export async function createTask(
  chatId: string,
  originalPrompt: string,
  threadId?: number,
  processedBy?: string
): Promise<AsyncTask | null> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const doc = await client.mutation(anyApi.asyncTasks.create, {
        chatId,
        originalPrompt,
        threadId,
        processedBy,
      });
      return doc ? convexToAsyncTask(doc) : null;
    } catch (err) {
      console.error("createTask error:", err);
      return null;
    }
  }

  if (backend === "supabase") {
    const { createTask: sbCreate } = await import("./supabase");
    return sbCreate(chatId, originalPrompt, threadId, processedBy);
  }

  return null;
}

/**
 * Update an async task's fields.
 */
export async function updateTask(
  taskId: string,
  updates: Partial<Omit<AsyncTask, "id" | "created_at">>
): Promise<boolean> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      // Convert snake_case update keys to camelCase for Convex
      const convexUpdates: Record<string, any> = {};
      if (updates.status !== undefined) convexUpdates.status = updates.status;
      if (updates.result !== undefined) convexUpdates.result = updates.result;
      if (updates.session_id !== undefined)
        convexUpdates.sessionId = updates.session_id;
      if (updates.current_step !== undefined)
        convexUpdates.currentStep = updates.current_step;
      if (updates.pending_question !== undefined)
        convexUpdates.pendingQuestion = updates.pending_question;
      if (updates.pending_options !== undefined)
        convexUpdates.pendingOptions = updates.pending_options;
      if (updates.user_response !== undefined)
        convexUpdates.userResponse = updates.user_response;
      if (updates.processed_by !== undefined)
        convexUpdates.processedBy = updates.processed_by;
      if (updates.reminder_sent !== undefined)
        convexUpdates.reminderSent = updates.reminder_sent;
      if (updates.metadata !== undefined)
        convexUpdates.metadata = updates.metadata;

      await client.mutation(anyApi.asyncTasks.update, {
        id: taskId,
        ...convexUpdates,
      });
      return true;
    } catch (err) {
      console.error("updateTask error:", err);
      return false;
    }
  }

  if (backend === "supabase") {
    const { updateTask: sbUpdate } = await import("./supabase");
    return sbUpdate(taskId, updates);
  }

  return false;
}

/**
 * Get a task by its ID.
 */
export async function getTaskById(taskId: string): Promise<AsyncTask | null> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const doc = await client.query(anyApi.asyncTasks.getById, {
        id: taskId,
      });
      return doc ? convexToAsyncTask(doc) : null;
    } catch {
      return null;
    }
  }

  if (backend === "supabase") {
    const { getTaskById: sbGet } = await import("./supabase");
    return sbGet(taskId);
  }

  return null;
}

/**
 * Get tasks waiting for user input in a specific chat.
 */
export async function getPendingTasks(chatId: string): Promise<AsyncTask[]> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const docs = await client.query(anyApi.asyncTasks.getPending, { chatId });
      return (docs || []).map(convexToAsyncTask);
    } catch {
      return [];
    }
  }

  if (backend === "supabase") {
    const { getPendingTasks: sbGet } = await import("./supabase");
    return sbGet(chatId);
  }

  return [];
}

/**
 * Get currently running tasks in a specific chat.
 */
export async function getRunningTasks(chatId: string): Promise<AsyncTask[]> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const docs = await client.query(anyApi.asyncTasks.getRunning, { chatId });
      return (docs || []).map(convexToAsyncTask);
    } catch {
      return [];
    }
  }

  if (backend === "supabase") {
    const { getRunningTasks: sbGet } = await import("./supabase");
    return sbGet(chatId);
  }

  return [];
}

/**
 * Get tasks that have been waiting for input longer than the threshold.
 */
export async function getStaleTasks(
  thresholdMs: number = 2 * 60 * 60 * 1000
): Promise<AsyncTask[]> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const docs = await client.query(anyApi.asyncTasks.getStale, {
        thresholdMs,
      });
      return (docs || []).map(convexToAsyncTask);
    } catch {
      return [];
    }
  }

  if (backend === "supabase") {
    const { getStaleTasks: sbGet } = await import("./supabase");
    return sbGet(thresholdMs);
  }

  return [];
}

// ---------------------------------------------------------------------------
// Node Heartbeat (Hybrid mode)
// ---------------------------------------------------------------------------

/**
 * Update heartbeat for a node.
 */
export async function upsertHeartbeat(
  nodeId: string,
  metadata?: Record<string, any>
): Promise<boolean> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      await client.mutation(anyApi.nodeHeartbeat.upsert, {
        nodeId,
        metadata: metadata || {},
      });
      return true;
    } catch (err) {
      console.error("upsertHeartbeat error:", err);
      return false;
    }
  }

  if (backend === "supabase") {
    const { upsertHeartbeat: sbUpsert } = await import("./supabase");
    return sbUpsert(nodeId, metadata);
  }

  return false;
}

/**
 * Check if a node is online (heartbeat within maxAgeMs).
 */
export async function getNodeStatus(
  nodeId: string,
  maxAgeMs: number = 90_000
): Promise<{ online: boolean; lastHeartbeat: string | null }> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const result = await client.query(anyApi.nodeHeartbeat.getStatus, {
        nodeId,
        maxAgeMs,
      });
      return result || { online: false, lastHeartbeat: null };
    } catch {
      return { online: false, lastHeartbeat: null };
    }
  }

  if (backend === "supabase") {
    const { getNodeStatus: sbGet } = await import("./supabase");
    return sbGet(nodeId, maxAgeMs);
  }

  return { online: false, lastHeartbeat: null };
}

// ---------------------------------------------------------------------------
// Scheduled Tasks
// ---------------------------------------------------------------------------

export interface ScheduledTask {
  id: string;
  created_at: string;
  chat_id: string;
  type: "reminder" | "action" | "recurring";
  prompt: string;
  scheduled_at: string;
  status: "pending" | "fired" | "cancelled";
  recurrence?: string;
}

function convexToScheduledTask(doc: any): ScheduledTask {
  return {
    id: doc._id,
    created_at: doc.createdAt
      ? new Date(doc.createdAt).toISOString()
      : new Date().toISOString(),
    chat_id: doc.chatId,
    type: doc.type,
    prompt: doc.prompt,
    scheduled_at: doc.scheduledAt
      ? new Date(doc.scheduledAt).toISOString()
      : new Date().toISOString(),
    status: doc.status,
    recurrence: doc.recurrence,
  };
}

/**
 * Create a scheduled task. Returns the task ID.
 */
export async function createScheduledTask(
  chatId: string,
  type: "reminder" | "action" | "recurring",
  prompt: string,
  scheduledAt: number, // epoch ms
  recurrence?: string
): Promise<string | null> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const id = await client.mutation(anyApi.scheduledTasks.create, {
        chatId,
        type,
        prompt,
        scheduledAt,
        recurrence,
      });
      return id;
    } catch (err) {
      console.error("createScheduledTask error:", err);
      return null;
    }
  }

  return null;
}

/**
 * List scheduled tasks for a chat.
 */
export async function listScheduledTasks(
  chatId: string,
  status?: "pending" | "fired" | "cancelled"
): Promise<ScheduledTask[]> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const docs = await client.query(anyApi.scheduledTasks.list, {
        chatId,
        status,
      });
      return (docs || []).map(convexToScheduledTask);
    } catch {
      return [];
    }
  }

  return [];
}

/**
 * Cancel a scheduled task by prompt text match.
 */
export async function cancelScheduledTask(
  chatId: string,
  searchText: string
): Promise<boolean> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const result = await client.mutation(
        anyApi.scheduledTasks.cancelBySearch,
        { chatId, searchText }
      );
      return !!result;
    } catch {
      return false;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Connection Test
// ---------------------------------------------------------------------------

/**
 * Test the database connection. Returns a descriptive status string.
 */
export async function testConnection(): Promise<string> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      // Try a simple query to verify connection
      await client.query(anyApi.memory.getFacts, {});
      return "Convex connection OK.";
    } catch (err) {
      return `Convex connection error: ${err}`;
    }
  }

  if (backend === "supabase") {
    const { testConnection: sbTest } = await import("./supabase");
    return sbTest();
  }

  return "No database configured (missing CONVEX_URL and SUPABASE_URL).";
}
