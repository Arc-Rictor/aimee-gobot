/**
 * Model Router — Tiered Model Selection
 *
 * Extracts complexity classification from anthropic-processor.ts
 * into a standalone module. Used by both the direct API processor
 * and the Agent SDK session manager.
 *
 * Cost-optimized: Default to Haiku (~$0.003/msg), only escalate
 * to Sonnet (~$0.15/msg) when tools are clearly needed, and to
 * Opus (~$0.50+/msg) for deep reasoning/strategy tasks.
 *
 * Distribution target: ~65% Haiku, ~25% Sonnet, ~10% Opus
 */

// ============================================================
// TYPES
// ============================================================

export type ModelTier = "haiku" | "sonnet" | "opus";

export const MODEL_IDS: Record<ModelTier, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-5-20250929",
  opus: "claude-opus-4-6",
};

// Cost per million tokens (input / output)
export const MODEL_COSTS: Record<ModelTier, { input: number; output: number }> =
  {
    haiku: { input: 0.8, output: 4.0 },
    sonnet: { input: 3.0, output: 15.0 },
    opus: { input: 15.0, output: 75.0 },
  };

// ============================================================
// PATTERNS
// ============================================================

// Patterns that indicate tool usage is needed (→ Sonnet)
const TOOL_PATTERNS = [
  /\b(wordpress|wp|blog post|website|theme|deploy|rollback)\b/i,
  /\b(publish|staging|production)\b.*\b(post|page|site)\b/i,
  /\b(send|reply|forward|draft)\b.*\b(email|message|whatsapp|linkedin)\b/i,
  /\b(email|message|whatsapp|linkedin)\b.*\b(send|reply|forward|draft)\b/i,
  /\b(create|add|update|delete|move|edit)\b.*\b(task|project|page|post|event)\b/i,
  /\b(task|project|page|post|event)\b.*\b(create|add|update|delete|move|edit)\b/i,
  /\b(schedule|book|block|cancel)\b.*\b(meeting|call|event|time)\b/i,
  /\b(github|pr|pull request|issue|commit|push|merge)\b/i,
  /\b(skool|community|members|analytics)\b/i,
  /\b(notion|database)\b.*\b(query|search|update|create)\b/i,
];

// Patterns that indicate complex reasoning (→ Opus)
const COMPLEX_PATTERNS = [
  /\b(analyze|analysis|evaluate|compare|contrast)\b/i,
  /\b(strategy|strategic|plan|roadmap|architecture)\b/i,
  /\b(write|draft|compose) .{50,}/i, // long writing requests
  /\b(research|investigate|deep dive)\b/i,
  /\b(decide|decision|should I|pros and cons)\b/i,
  /\b(explain in detail|why should|how does .{50,})\b/i, // complex explanations
  /\b(refactor|redesign|optimize|improve)\b/i,
  /\b(sponsor|partnership|brand deal|negotiate)\b/i,
  /\b(content strategy|video idea|script)\b/i,
];

// ============================================================
// CLASSIFIER
// ============================================================

/**
 * Classify message complexity to select the right model tier.
 * Zero overhead — pure regex matching, no API calls.
 *
 * Cost-optimized: defaults to Haiku. Only escalates when
 * tool usage or deep reasoning is clearly needed.
 */
export function classifyComplexity(message: string): ModelTier {
  // Short casual messages: skip straight to Haiku unless tools are needed
  if (message.length < 100) {
    const needsTools = TOOL_PATTERNS.some((p) => p.test(message));
    if (!needsTools) return "haiku";
  }

  // Check complex patterns first (Opus)
  for (const pattern of COMPLEX_PATTERNS) {
    if (pattern.test(message)) return "opus";
  }

  // Check tool patterns (Sonnet)
  for (const pattern of TOOL_PATTERNS) {
    if (pattern.test(message)) return "sonnet";
  }

  // Default: Haiku (conversational, greetings, short questions, status checks)
  return "haiku";
}

/**
 * Map a model ID for OpenRouter (adds "anthropic/" prefix).
 */
export function toOpenRouterModel(model: string): string {
  if (model.startsWith("anthropic/")) return model;
  return `anthropic/${model}`;
}

/**
 * Select model ID for a message, with optional budget-based downgrade.
 */
export function selectModelForMessage(
  message: string,
  budgetRemaining?: number
): { tier: ModelTier; model: string } {
  const tier = classifyComplexity(message);

  // Downgrade Opus → Sonnet if budget is running low (< $1 remaining)
  const effectiveTier =
    tier === "opus" && budgetRemaining !== undefined && budgetRemaining < 1.0
      ? "sonnet"
      : tier;

  return {
    tier: effectiveTier,
    model: MODEL_IDS[effectiveTier],
  };
}
