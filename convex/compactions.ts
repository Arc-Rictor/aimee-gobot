import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Insert a compaction summary for a chat.
 */
export const insert = mutation({
  args: {
    chatId: v.string(),
    summary: v.string(),
    messagesCompacted: v.number(),
    oldestMessageAt: v.number(),
    newestMessageAt: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("compactions", {
      createdAt: Date.now(),
      chatId: args.chatId,
      summary: args.summary,
      messagesCompacted: args.messagesCompacted,
      oldestMessageAt: args.oldestMessageAt,
      newestMessageAt: args.newestMessageAt,
    });
  },
});

/**
 * Get the most recent compaction for a chat.
 */
export const getLatest = query({
  args: {
    chatId: v.string(),
  },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("compactions")
      .withIndex("by_chatId_createdAt", (q) => q.eq("chatId", args.chatId))
      .order("desc")
      .take(1);
    return results[0] ?? null;
  },
});

/**
 * Count messages for a chat since a given timestamp.
 */
export const countMessagesSince = query({
  args: {
    chatId: v.string(),
    since: v.number(),
  },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_chatId_createdAt", (q) =>
        q.eq("chatId", args.chatId).gt("createdAt", args.since)
      )
      .collect();
    return messages.length;
  },
});

/**
 * Get messages for a chat in a time range (for compaction input).
 */
export const getMessagesInRange = query({
  args: {
    chatId: v.string(),
    after: v.number(),
    before: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 200;
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_chatId_createdAt", (q) =>
        q.eq("chatId", args.chatId).gt("createdAt", args.after).lt("createdAt", args.before)
      )
      .order("asc")
      .take(limit);
    return messages;
  },
});
