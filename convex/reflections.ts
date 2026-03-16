import { query, mutation, action } from "./_generated/server";
import { v } from "convex/values";

/**
 * Insert a new daily reflection.
 */
export const insert = mutation({
  args: {
    date: v.string(),
    content: v.string(),
    themes: v.array(v.string()),
    carryForward: v.string(),
    inputSummary: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("reflections", {
      createdAt: Date.now(),
      date: args.date,
      content: args.content,
      themes: args.themes,
      carryForward: args.carryForward,
      inputSummary: args.inputSummary,
      metadata: args.metadata ?? {},
    });
  },
});

/**
 * Get a reflection by date (YYYY-MM-DD).
 */
export const getByDate = query({
  args: { date: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("reflections")
      .withIndex("by_date", (q) => q.eq("date", args.date))
      .first();
  },
});

/**
 * Get the most recent N reflections.
 */
export const getRecent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 7;
    return await ctx.db
      .query("reflections")
      .withIndex("by_date")
      .order("desc")
      .take(limit);
  },
});

/**
 * Semantic search across reflections.
 */
export const semanticSearch = action({
  args: {
    vector: v.array(v.float64()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.vectorSearch("reflections", "by_embedding", {
      vector: args.vector,
      limit: args.limit ?? 5,
    });
  },
});
