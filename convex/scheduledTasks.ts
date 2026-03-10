import {
  mutation,
  query,
  internalMutation,
  internalAction,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";

// ============================================================
// PUBLIC: Create a scheduled task
// ============================================================

export const create = mutation({
  args: {
    chatId: v.string(),
    type: v.union(
      v.literal("reminder"),
      v.literal("action"),
      v.literal("recurring")
    ),
    prompt: v.string(),
    scheduledAt: v.number(), // epoch ms
    recurrence: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const taskId = await ctx.db.insert("scheduledTasks", {
      createdAt: now,
      updatedAt: now,
      chatId: args.chatId,
      type: args.type,
      prompt: args.prompt,
      scheduledAt: args.scheduledAt,
      status: "pending",
      recurrence: args.recurrence,
      metadata: args.metadata ?? {},
    });

    // Use Convex's built-in durable scheduler
    const scheduledId = await ctx.scheduler.runAt(
      args.scheduledAt,
      internal.scheduledTasks.fire,
      { taskId }
    );

    await ctx.db.patch(taskId, {
      convexScheduledId: scheduledId.toString(),
    });

    return taskId;
  },
});

// ============================================================
// PUBLIC: List scheduled tasks
// ============================================================

export const list = query({
  args: {
    chatId: v.string(),
    status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("fired"),
        v.literal("cancelled")
      )
    ),
  },
  handler: async (ctx, args) => {
    if (args.status) {
      return await ctx.db
        .query("scheduledTasks")
        .withIndex("by_chatId_status", (q) =>
          q.eq("chatId", args.chatId).eq("status", args.status!)
        )
        .order("asc")
        .collect();
    }
    return await ctx.db
      .query("scheduledTasks")
      .withIndex("by_chatId", (q) => q.eq("chatId", args.chatId))
      .order("desc")
      .take(50);
  },
});

// ============================================================
// PUBLIC: Get a task by ID
// ============================================================

export const getById = query({
  args: { id: v.id("scheduledTasks") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// ============================================================
// PUBLIC: Cancel a task by ID
// ============================================================

export const cancel = mutation({
  args: { id: v.id("scheduledTasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.id);
    if (!task || task.status !== "pending") return false;

    if (task.convexScheduledId) {
      try {
        await ctx.scheduler.cancel(task.convexScheduledId as any);
      } catch {
        // May already have fired
      }
    }

    await ctx.db.patch(args.id, {
      status: "cancelled",
      updatedAt: Date.now(),
    });

    return true;
  },
});

// ============================================================
// PUBLIC: Cancel by prompt text match
// ============================================================

export const cancelBySearch = mutation({
  args: {
    chatId: v.string(),
    searchText: v.string(),
  },
  handler: async (ctx, args) => {
    const pending = await ctx.db
      .query("scheduledTasks")
      .withIndex("by_chatId_status", (q) =>
        q.eq("chatId", args.chatId).eq("status", "pending")
      )
      .collect();

    const lower = args.searchText.toLowerCase();
    const match = pending.find((t) =>
      t.prompt.toLowerCase().includes(lower)
    );

    if (!match) return null;

    if (match.convexScheduledId) {
      try {
        await ctx.scheduler.cancel(match.convexScheduledId as any);
      } catch {
        // May already have fired
      }
    }

    await ctx.db.patch(match._id, {
      status: "cancelled",
      updatedAt: Date.now(),
    });

    return match._id;
  },
});

// ============================================================
// INTERNAL: Fire a scheduled task — sends Telegram message
// ============================================================

export const fire = internalAction({
  args: { taskId: v.id("scheduledTasks") },
  handler: async (ctx, args) => {
    const task = await ctx.runQuery(api.scheduledTasks.getById, {
      id: args.taskId,
    });

    if (!task || task.status !== "pending") return;

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = task.chatId || process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
      console.error(
        "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID for scheduled task"
      );
      return;
    }

    // Format message based on type
    let message: string;
    switch (task.type) {
      case "reminder":
        message = `⏰ *Reminder*\n\n${escapeMarkdown(task.prompt)}`;
        break;
      case "action":
        message = `⚡ *Scheduled Action*\n\n${escapeMarkdown(task.prompt)}\n\n_Reply to this message to execute it._`;
        break;
      case "recurring":
        message = `🔄 *Recurring*\n\n${escapeMarkdown(task.prompt)}`;
        break;
      default:
        message = `📋 ${escapeMarkdown(task.prompt)}`;
    }

    // Send via Telegram Bot API
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: "Markdown",
          }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        console.error("Telegram send error:", error);
      }
    } catch (err) {
      console.error("Failed to send Telegram notification:", err);
    }

    // Mark as fired
    await ctx.runMutation(internal.scheduledTasks.markFired, {
      id: args.taskId,
    });

    // If recurring, schedule the next occurrence
    if (task.type === "recurring" && task.recurrence) {
      await ctx.runMutation(internal.scheduledTasks.scheduleNext, {
        taskId: args.taskId,
      });
    }
  },
});

// ============================================================
// INTERNAL: Mark task as fired
// ============================================================

export const markFired = internalMutation({
  args: { id: v.id("scheduledTasks") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      status: "fired",
      updatedAt: Date.now(),
    });
  },
});

// ============================================================
// INTERNAL: Schedule next occurrence of a recurring task
// ============================================================

export const scheduleNext = internalMutation({
  args: { taskId: v.id("scheduledTasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task || !task.recurrence) return;

    const nextTime = computeNextFireTime(task.scheduledAt, task.recurrence);
    if (!nextTime) return;

    const now = Date.now();
    const newTaskId = await ctx.db.insert("scheduledTasks", {
      createdAt: now,
      updatedAt: now,
      chatId: task.chatId,
      type: "recurring",
      prompt: task.prompt,
      scheduledAt: nextTime,
      status: "pending",
      recurrence: task.recurrence,
      metadata: task.metadata,
    });

    const scheduledId = await ctx.scheduler.runAt(
      nextTime,
      internal.scheduledTasks.fire,
      { taskId: newTaskId }
    );

    await ctx.db.patch(newTaskId, {
      convexScheduledId: scheduledId.toString(),
    });
  },
});

// ============================================================
// HELPERS
// ============================================================

/**
 * Escape Telegram Markdown v1 special characters.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/([_[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

/**
 * Compute next fire time based on recurrence pattern.
 */
function computeNextFireTime(
  lastFireAt: number,
  recurrence: string
): number | null {
  const now = Date.now();
  const r = recurrence.toLowerCase().trim();

  // "every Xh" or "every X hours"
  const hoursMatch = r.match(/every\s+(\d+)\s*h(?:ours?)?/);
  if (hoursMatch) {
    const ms = parseInt(hoursMatch[1], 10) * 60 * 60 * 1000;
    let next = lastFireAt + ms;
    while (next <= now) next += ms;
    return next;
  }

  // "every Xm" or "every X minutes"
  const minsMatch = r.match(/every\s+(\d+)\s*m(?:in(?:ute)?s?)?/);
  if (minsMatch) {
    const ms = parseInt(minsMatch[1], 10) * 60 * 1000;
    let next = lastFireAt + ms;
    while (next <= now) next += ms;
    return next;
  }

  // "daily" = every 24 hours
  if (r === "daily") {
    const ms = 24 * 60 * 60 * 1000;
    let next = lastFireAt + ms;
    while (next <= now) next += ms;
    return next;
  }

  // "hourly" = every 1 hour
  if (r === "hourly") {
    const ms = 60 * 60 * 1000;
    let next = lastFireAt + ms;
    while (next <= now) next += ms;
    return next;
  }

  // "weekdays" = next weekday at same time
  if (r.includes("weekday")) {
    const d = new Date(lastFireAt);
    do {
      d.setDate(d.getDate() + 1);
    } while (d.getDay() === 0 || d.getDay() === 6 || d.getTime() <= now);
    return d.getTime();
  }

  // "weekly" = every 7 days
  if (r === "weekly") {
    const ms = 7 * 24 * 60 * 60 * 1000;
    let next = lastFireAt + ms;
    while (next <= now) next += ms;
    return next;
  }

  return null;
}
