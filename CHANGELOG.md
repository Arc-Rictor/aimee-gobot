# Gobot Changelog

## v2.11.0 — 2026-03-20

**Feedback Loop — Adaptive Interaction Scoring**

GoBot now scores your interactions and generates patterns that feed back into the system prompt. Over time, it learns which areas it handles well and where it needs more care — making every session better than the last.

### How It Works

```
Daily: score interactions → detect patterns → update gobot-patterns.md
Weekly: analyze trends → generate summary → send to Telegram
```

The feedback loop auto-detects your setup:
- **Convex** → reads messages + stores scores in Convex
- **Claude Code** → parses JSONL from `~/.claude/history/` (local/hybrid users)
- **Local** → reads from message history JSON + stores scores locally

### New Features

- **Interaction Scoring** — Each session scored 0-100 based on message count, tool usage, corrections, and appreciations. Labels: `excellent`, `good`, `fair`, `poor`.
- **Pattern Generation** — `config/gobot-patterns.md` auto-generated with per-channel stats, focus area breakdowns, and actionable insights.
- **Weekly Analysis** — `--analyze` flag generates a weekly summary with trends, best/weakest areas, and sends it to Telegram.
- **Backfill** — `--backfill=N` scores the last N days in one go.
- **Duplicate Prevention** — Checks if scores exist for a date before re-scoring (override with `--force`).

### New Files

- `src/feedback.ts` — CLI entry point (`bun run feedback`)
- `src/lib/feedback-loop.ts` — Scoring engine, pattern generator, weekly analyzer
- `convex/interactionScores.ts` — Convex mutations/queries (insertBatch, getByDateRange, existsForDate)
- `config/gobot-patterns.md` — Auto-generated patterns file (gitignored output, template committed)

### Usage

```bash
bun run feedback              # score today's interactions
bun run feedback --backfill=5 # score last 5 days
bun run feedback --analyze    # generate weekly patterns + send to Telegram
bun run feedback --force      # re-score even if already done
```

---

## v2.10.0 — 2026-03-19

**MCPManager — Model-Agnostic MCP Tool Access**

When Claude is rate-limited and GoBot falls back to OpenRouter or Ollama, MCP tools (Notion, email, calendar, etc.) used to be lost — the fallback was plain text only. Now, MCPManager boots your MCP servers at startup and provides tools to **any** model, regardless of provider.

### The Problem

```
BEFORE:
  Claude rate limited → OpenRouter picks up → no tools → "I can't access your calendar"

AFTER:
  Claude rate limited → OpenRouter picks up → MCPManager provides tools → full access ✅
```

### How It Works

MCPManager is a singleton that:
1. **Discovers** your bun-based MCP servers from `config/mcp-servers.json` or `~/.claude.json`
2. **Boots** them at startup via the MCP SDK Client (concurrent init, ~1s)
3. **Converts** tool schemas to both Anthropic format (for direct API) and OpenAI format (for OpenRouter/Ollama)
4. **Routes** tool calls to the correct MCP server when any model requests them
5. **Falls back gracefully** — if a model doesn't support function calling, retries without tools automatically

### New Features

- **MCPManager** (`src/lib/mcp-client.ts`) — Boots MCP servers, discovers tools, converts schemas, routes calls. Singleton with proper lifecycle management (startup, shutdown, cleanup on exit).
- **Fallback function calling** — `fallback-llm.ts` rewritten with an OpenAI-compatible tool calling loop. Models that support function calling (DeepSeek, Llama 3.1+, Qwen 2.5+, Mistral, GPT-4) get full MCP tool access.
- **Auto-retry without tools** — If a model rejects tool definitions (older/smaller models), automatically retries the request without tools. No error to the user.
- **VPS direct API gets MCP tools** — `anthropic-processor.ts` now merges MCP tools with existing hard-coded tools (phone_call, ask_user, scheduling). The direct API path goes from 5 tools to 5 + all your MCP tools.
- **Dynamic system prompt** — VPS system prompt adapts based on whether MCP tools are available.

### New Files

- `src/lib/mcp-client.ts` — MCPManager class (config loading, server lifecycle, tool conversion, call routing)
- `config/mcp-servers.example.json` — Template for custom MCP server config
- `setup/test-mcp-client.ts` — MCPManager verification (server discovery, tool listing, test call)
- `setup/test-fallback-with-tools.ts` — End-to-end fallback test (simulates rate limit → verifies tools work through OpenRouter)

### Changed Files

- `src/lib/fallback-llm.ts` — Rewritten: OpenAI-compatible function calling loop with MCP tools, system prompt, truncation, auto-retry without tools
- `src/lib/anthropic-processor.ts` — Imports MCPManager, merges MCP tools into `buildToolDefinitions()`, routes MCP tool calls in `executeTool()`, dynamic system prompt
- `src/vps-gateway.ts` — Imports MCPManager, `await mcpManager.init()` at startup, status in boot log
- `package.json` — Added `@modelcontextprotocol/sdk` dependency
- `CLAUDE.md` — Documented MCP tools feature in Phase 8, added `mcp-client.ts` to project structure

### Config Priority

MCPManager looks for server configs in this order:
1. `config/mcp-servers.json` — GoBot-specific (create from `config/mcp-servers.example.json`)
2. `MCP_CONFIG_PATH` env var — Custom path
3. `~/.claude.json` — Auto-discovers bun-based servers from your Claude Code config

Only bun-based servers are started. npx-based servers are skipped (zombie process risk).

### Setup

**Zero config needed** if you already have bun-based MCP servers in your Claude Code setup. MCPManager discovers them automatically.

**Custom config:**
```bash
cp config/mcp-servers.example.json config/mcp-servers.json
# Edit with your MCP server paths
```

**Verify:**
```bash
bun run setup/test-mcp-client.ts           # Test server discovery
bun run setup/test-fallback-with-tools.ts   # Test full fallback flow
```

### Upgrade Path (Existing Users)

```bash
git pull origin master
bun install   # installs @modelcontextprotocol/sdk
```

No other changes needed. MCPManager activates automatically on VPS mode if MCP servers are found.

### Compatibility

- Fully backward compatible. If no MCP servers are found, everything works exactly as before.
- Local mode (bot.ts) is unaffected — Claude Code already handles MCP tools.
- MCPManager only activates in VPS mode (`bun run vps`).

---

## v2.9.0 — 2026-03-10

**Scheduled Tasks & Reminders via Convex**

Durable scheduling powered by Convex's `ctx.scheduler.runAt()`. Users can say "remind me at 5pm", "check emails tonight", or "every morning at 9am" — tasks persist across restarts, survive server reboots, and fire even when machines are offline.

### New Features
- **3 new VPS tools**: `schedule_task`, `list_scheduled_tasks`, `cancel_scheduled_task` (gated on `CONVEX_URL`)
- **3 task types**: `reminder` (notify), `action` (notify + prompt to execute), `recurring` (repeats)
- **Recurrence patterns**: `daily`, `hourly`, `weekly`, `weekdays`, `every Xh`, `every Xm`
- **Time parsing**: ISO 8601, relative ("in 2 hours"), clock time ("5pm", "17:30")
- **Automated setup**: `bun run setup:convex` reuses existing Telegram credentials

### New Files
- `convex/scheduledTasks.ts` — Convex backend: create, list, cancel, fire (internal action), recurrence
- `setup/configure-convex.ts` — Automated Convex setup (reuses `.env` credentials, creates test reminder)
- `docs/scheduling.md` — Full documentation (setup, task types, architecture, troubleshooting)

### Changed Files
- `convex/schema.ts` — Added `scheduledTasks` table with status/chatId indexes
- `src/lib/convex.ts` — Added `createScheduledTask()`, `listScheduledTasks()`, `cancelScheduledTask()`
- `src/lib/anthropic-processor.ts` — Added scheduling tools + `resolveScheduledTime()` parser
- `package.json` — Added `setup:convex` script

### Upgrade Path (Existing Users)
```bash
git pull origin master
bun install
# If not using Convex yet:
bun run setup:convex
# If already using Convex:
npx convex dev --once   # deploys new scheduledTasks table
```

---

## v2.8.0 — 2026-03-04

**Convex Migration + Database Choice for Community Members**

GoBot now uses Convex as its primary database backend, with Supabase as a fully supported first-class alternative. The runtime already handled both transparently — this release updates the docs, setup flow, and health checks so community members explicitly choose their database during Phase 2 setup.

### Changes

- **`.env.example`** — Database section now presents Option A (Convex) and Option B (Supabase) side by side, both commented out by default. No "REQUIRED" or "LEGACY" labels.
- **`CLAUDE.md` Phase 2** — Full rewrite as a choice-driven section with comparison table, Phase 2A (Convex) and Phase 2B (Supabase) sub-sections, and a "switching later" guide.
- **`CLAUDE.md` Phase 0** — Environment scan now reports whichever backend is active without suggesting migration. Both backends skip Phase 2.
- **`CLAUDE.md` Phase 2.5** — Semantic search instructions split by database backend (Convex env var vs Supabase `.env` key).
- **`CLAUDE.md` Phase 9** — VPS `.env` example shows both database options.
- **`db/schema.sql`** — Deprecation header replaced with clean "Supabase Schema" header. No functional changes.
- **`setup/verify.ts`** — Health check is now database-agnostic: `checkRequiredEnv()` checks for either backend, `checkSupabase()` renamed to `checkDatabase()` and tests whichever is configured.
- **Code comment cleanup** — Removed all "legacy" and "deprecation" wording from `convex.ts`, `asset-store.ts`, `vps-gateway.ts`, `vps-convex-client.ts`, `model-router.ts`, and `.env.example`.

### New Files
- `convex/` — Full Convex backend (schema, messages, memory, logs, async tasks, assets, embeddings, knowledge base, migrations)
- `scripts/migrate-to-convex.ts` — Supabase → Convex data migration script
- `setup/test-convex.ts` — Convex connectivity test
- `src/lib/convex.ts` — Database client with tiered fallback (Convex → Supabase → local JSON)
- `vps-convex-client.ts` — Lightweight Convex client for VPS mode

### Compatibility
- Fully backward compatible. Existing Supabase setups continue to work with zero changes.
- If both `CONVEX_URL` and `SUPABASE_URL` are set, Convex takes priority.
- No code logic changes — the runtime fallback already worked.

---

## v2.7.0 — 2026-03-03

**Resilient API Fallback (Anthropic → OpenRouter) + Cost-Optimized Model Routing**

When Anthropic API goes down (credit depletion, rate limits, outages), all API calls now seamlessly failover to OpenRouter using the same `@anthropic-ai/sdk` — zero format conversion, zero disruption. The system re-checks Anthropic every 15 minutes and automatically switches back when it recovers. Additionally, the model classifier has been tuned to default to Haiku instead of Sonnet, saving ~42% on API costs with no quality loss for simple messages.

### New Features

- **Resilient client** — New `resilient-client.ts` module provides automatic Anthropic → OpenRouter failover. All 6 files that make Anthropic API calls now route through this single module. Detects credit errors (401, 402, 429, 529) and message patterns (`credit balance is too low`, `insufficient_quota`, etc.).
- **OpenRouter is optional** — If `OPENROUTER_API_KEY` is not set, the resilient client gracefully degrades: no failover, errors propagate normally. Safe for community members without OpenRouter accounts.
- **Agent SDK failover** — When the Agent SDK (Sonnet/Opus tier) hits a credit error, it automatically retries with OpenRouter env vars (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`). Same Claude Code capabilities, different billing backend.
- **Cost-optimized classifier** — Default model tier changed from Sonnet to Haiku. New `TOOL_PATTERNS` escalate to Sonnet only for tool-requiring tasks (WordPress, email, calendar, GitHub, Notion, etc.). Target distribution: 65% Haiku, 25% Sonnet, 10% Opus.
- **Web search stripping** — `web_search_20250305` tool (Anthropic-only) is automatically removed from tool arrays when routing through OpenRouter.

### New Files
- `src/lib/resilient-client.ts` — Resilient Anthropic client with automatic OpenRouter failover

### Updated Files
- `src/lib/model-router.ts` — Added `toOpenRouterModel()` export, replaced `SIMPLE_PATTERNS` with `TOOL_PATTERNS`, default tier changed to Haiku
- `src/lib/anthropic-processor.ts` — Uses `getResilientClient()` and `createResilientMessage()` instead of direct `new Anthropic()`
- `src/lib/agent-session.ts` — Pre-checks `isAnthropicAvailable()`, routes Agent SDK env vars through OpenRouter when needed, catches credit errors with auto-retry
- `src/lib/voice.ts` — `summarizeTranscript()` and `extractTaskFromTranscript()` use resilient client; accepts `OPENROUTER_API_KEY` as fallback
- `src/lib/asset-store.ts` — `describeImageFromBuffer()` migrated from raw `fetch()` to SDK via `createResilientMessage()`; accepts `OPENROUTER_API_KEY`
- `src/vps-gateway.ts` — `processCallTaskOnVPS()` uses resilient client instead of dynamic `import("@anthropic-ai/sdk")`

### How It Works

```
API call needed?
  ├── Anthropic available? → Use Anthropic (direct)
  │     └── Credit/auth error? → Mark down, retry via OpenRouter
  └── Anthropic down? → Use OpenRouter (same SDK, different baseURL)
        └── Re-check Anthropic every 15 minutes
```

### Setup

To enable failover, add to your `.env`:
```bash
OPENROUTER_API_KEY=sk-or-v1-your_key   # Optional — enables automatic failover
```

No other changes needed. Anthropic remains the primary provider. OpenRouter activates only on failure.

### Compatibility
- Fully backward compatible. No config changes required.
- Without `OPENROUTER_API_KEY`: behaves exactly as before (no failover).
- Existing `OPENROUTER_API_KEY` (from fallback-llm setup) is reused automatically.

---

## v2.6.1 — 2026-02-24

**Universal Fallback — OpenRouter/Ollama now works on VPS + catches subscription limits**

Fallback to OpenRouter and Ollama was only wired up for local (Mac) mode. If Anthropic API failed on VPS, the bot returned a generic error instead of trying backup LLMs. Additionally, Claude Pro/Max subscription limit messages weren't detected as errors, so fallback never triggered even on local.

### Fixes

- **VPS fallback** — `anthropic-processor.ts` and `agent-session.ts` now call `callFallbackLLM()` when Anthropic API or Agent SDK fails. Previously only the local Claude Code subprocess paths had fallback.
- **VPS resume fallback** — Both Agent SDK and Anthropic API resume paths in `bot.ts` now try fallback LLMs before returning "Error resuming task."
- **Subscription limit detection** — Added 12 new error patterns to `isClaudeErrorResponse()` covering Pro, Max, and any subscription tier limits: `hit your limit`, `usage limit`, `usage cap`, `message limit`, `reached your limit`, `out of messages`, `no messages remaining`, `upgrade to`, `exceeds your plan`, `plan limit`, `token limit reached`, `conversation limit`.
- **Case-insensitive matching** — Error pattern detection now uses case-insensitive comparison (was case-sensitive before).

### Updated Files
- `src/lib/claude.ts` — Extended error patterns + case-insensitive matching
- `src/lib/anthropic-processor.ts` — Import + call `callFallbackLLM()` on API failure
- `src/lib/agent-session.ts` — Import + call `callFallbackLLM()` on SDK failure
- `src/bot.ts` — VPS resume catch blocks now try fallback before returning errors

### How It Works Now

```
Any mode (Local / VPS / Hybrid):
  Claude fails? (API error, subscription limit, timeout)
    ├── Try OpenRouter (if OPENROUTER_API_KEY is set)
    ├── Try Ollama (if running locally)
    └── Return error message (only if both fail)
```

### Setup Reminder

To enable fallback, set these in your `.env`:
```bash
OPENROUTER_API_KEY=sk-or-v1-your_key
OPENROUTER_MODEL=moonshotai/kimi-k2.5      # or any model
OLLAMA_MODEL=qwen3-coder                    # if running Ollama locally
```

---

## v2.6.0 — 2026-02-23

**Multi-Bot Agent Identities + Cross-Agent Consultation + Board Meetings**

Each agent can now have its own Telegram bot, so messages appear from separate identities (Research Bot, Finance Bot, etc.) instead of all coming from the main bot. Agents can consult each other mid-conversation, and the new `/board` command triggers a full multi-agent discussion on any topic.

### New Features

- **Multi-bot agent identities** — Create separate Telegram bots for Research, Content, Finance, Strategy, and Critic agents. Each agent sends messages from its own bot account. Falls back to main bot for any unconfigured agent.
- **Cross-agent consultation** — Agents can invoke each other mid-conversation using `[INVOKE:agent|question]` tags. Visible inter-agent communication with responses shown in the chat.
- **Board meetings (`/board`)** — Triggers a sequential multi-agent discussion. All configured agents weigh in on a topic, then a synthesis is generated. Example: `/board Should we launch a paid newsletter?`
- **Knowledge base framework** (WIP) — Embedding-based knowledge retrieval via Supabase edge function. Foundation for future RAG capabilities.

### Setup Flow

- **CLAUDE.md Phase 4** now includes full multi-bot setup instructions: BotFather walkthrough, env var names, cross-agent explanation, `/board` usage
- **`bun run setup:verify`** now checks agent bot tokens (new section `[5/6] Multi-Bot Agent Identities`) — validates each token against Telegram API, reports graceful fallback for missing ones

### New Files
- `src/lib/bot-registry.ts` — `BotRegistry` class mapping agent names to individual Grammy Bot instances (outbound-only, no polling)
- `src/lib/cross-agent.ts` — `[INVOKE:agent|question]` parser and executor
- `src/lib/knowledge-base.ts` — Embedding framework (WIP)
- `supabase/functions/embed-knowledge/index.ts` — Edge function for embeddings

### Updated Files
- `src/bot.ts` — Board meeting mode, cross-agent invocation, BotRegistry integration
- `src/vps-gateway.ts` — VPS-native board meeting support
- `src/lib/supabase.ts` — `getBoardMeetingContext()` function
- `src/lib/agent-session.ts` — Skip progress on HITL resume
- `src/agents/general.ts`, `content.ts`, `finance.ts`, `research.ts`, `strategy.ts` — Cross-agent consultation instructions in system prompts
- `.env.example` — Documents `TELEGRAM_BOT_TOKEN_RESEARCH/CONTENT/FINANCE/STRATEGY/CRITIC`
- `CLAUDE.md` — Phase 4 multi-bot setup, cross-agent docs, `/board` usage
- `setup/verify.ts` — Agent bot token validation (section 5/6)

### Compatibility
- Fully backward compatible. All features are optional.
- Without agent bot tokens: everything works exactly as before, all agents use the main bot.
- Add 1, 3, or all 5 agent tokens — missing ones fall back to the main bot.

---

## v2.5.3 — 2026-02-19

**ZIP-to-Git Upgrade + Setup Detection**

Community members who downloaded GoBot as a ZIP file couldn't pull updates — they had to manually re-download and merge files. Now there's a one-command upgrade path that connects any installation to the official repo.

### New

- **`bun run upgrade`** — Smart upgrade script that detects your installation type and connects it to the official repo:
  - ZIP download (no `.git/`): initializes git, connects to `autonomee/gobot`, aligns with master
  - Wrong remote (personal fork): adds `upstream` for official repo, keeps fork as `origin`
  - Proper clone: pulls latest with stash/unstash safety
  - All user config (`.env`, profile, schedule, tokens) preserved — everything is gitignored
  - Post-upgrade: reinstalls dependencies, checks schema, warns about running services
- **Phase 0 git detection** — `bun run setup` now checks if the project is a ZIP download and recommends `bun run upgrade` before continuing
- **README upgrade section** — Clear instructions for ZIP users to connect to the repo

### Updated Files
- `setup/upgrade.ts` — New upgrade script (3 scenarios: ZIP, wrong remote, proper clone)
- `setup/install.ts` — Added git repo detection in prerequisites check
- `package.json` — Added `"upgrade"` script
- `CLAUDE.md` — Phase 0 now includes git/ZIP detection as step 1
- `README.md` — Added "Downloaded as ZIP?" section

### Why This Matters
Future updates (new features, bug fixes, security patches) are now just `git pull origin master` for everyone — regardless of how they originally got the code.

---

## v2.5.2 — 2026-02-18

**Agent SDK Full Capabilities**

The Agent SDK was missing critical configuration that prevented Skills, hooks, and full tool access from working on VPS deployments. Community members deploying GoBot on VPS now get the same full Claude Code experience as desktop.

### Fixes
- **Skills not loading on VPS** — Added `allowedTools` with all 12 built-in tools including `Skill`. Previously the Agent SDK had no tool allowlist, so Skills were never discovered.
- **User settings ignored** — Changed `settingSources` from `["project"]` to `["user", "project"]`. Now loads `~/.claude/CLAUDE.md`, `~/.claude/skills/`, and `~/.claude/rules/` from the user's home directory.
- **Agent hangs on VPS** — Added `permissionMode: "bypassPermissions"` for headless environments (no TTY for interactive prompts).
- **No security guardrails** — Added programmatic hooks: `PostToolUse` logging for observability, `PreToolUse` security blocks for destructive Bash commands (rm -rf, mkfs, iptables flush, etc.).
- **Bun not found on VPS** — PATH now dynamically includes `~/.bun/bin`. Added `BUN_PATH` env override for custom Bun installations.
- **No thinking/effort settings** — Added per-tier thinking (adaptive for Opus, disabled otherwise) and effort levels (low/medium/high).
- **Session persistence** — Added `persistSession: true` for proper HITL resume across ask_user pauses.

### Updated Files
- `src/lib/agent-session.ts` — All 7 fixes above
- `CLAUDE.md` — Updated settingSources documentation

### Compatibility
- Fully backward compatible. No config changes required.
- Users without `~/.claude/` directory get the same behavior as before.
- Users WITH Claude Code skills/rules get them automatically on VPS.

---

## v2.5.1 — 2026-02-16

**Fallback Fixes**

Fixed two bugs in the fallback LLM chain that caused billing errors to leak through to users instead of triggering the Ollama/OpenRouter fallback, and added offline-only fallback mode.

### Bug Fixes
- **Billing errors bypass fallback** — `isClaudeErrorResponse()` now catches `credit balance`, `add funds`, `billing`, `insufficient_quota`, and `payment_required` errors. Previously these were passed through as bot responses instead of triggering the fallback chain.
- **Fallback source ambiguity** — The `_(responded via fallback)_` tag now shows which backend actually answered: `_(responded via ollama)_` or `_(responded via openrouter)_`.

### New Features
- **`FALLBACK_OFFLINE_ONLY` env var** — Set to `true` to skip OpenRouter and go straight to Ollama for fully offline operation. Useful when you want the fallback chain to be 100% local with no paid API calls.

### Updated Files
- `src/lib/claude.ts` — Added 5 billing-related error patterns to `isClaudeErrorResponse()`
- `src/lib/fallback-llm.ts` — Added `FALLBACK_OFFLINE_ONLY` support, source indicator, exported `FallbackResult` type
- `src/bot.ts` — Removed duplicate `_(responded via fallback)_` tag (now handled by `callFallbackLLM` itself)
- `.env.example` — Documented `FALLBACK_OFFLINE_ONLY` option

### Compatibility
- Fully backward compatible. No config changes required.
- Existing setups without `FALLBACK_OFFLINE_ONLY` behave exactly as before (OpenRouter first, then Ollama).

---

## v2.5.0 — 2026-02-16

**Reliability & VPS Hardening**

Six bugs fixed that were discovered in production, plus VPS documentation improvements.

### Bug Fixes
- **ElevenLabs voice calls fail on empty context** — `buildVoiceAgentContext()` and `initiatePhoneCall()` now provide fallback text when Supabase returns empty memory, chat history, or goals. Previously, ElevenLabs received empty dynamic variables and the agent had no context.
- **Call transcripts sent twice** — Added `processedCallIds` dedup set. Both the polling loop and webhook handler now check before processing, so only the first one to complete sends the summary.
- **Morning briefing sent twice** — Added dedup check using `lastBriefingDate` in `checkin-state.json`. If a briefing was already sent today (e.g. after sleep/wake catch-up), it skips.
- **Phantom DONE/CANCEL tags** — Intent detection now requires minimum 5 characters for `[DONE:]` and `[CANCEL:]` tags, preventing vague matches. All intent processing is logged for visibility.
- **Bot promises to fix itself** — Added LIMITATIONS section to both system prompts (direct API + Agent SDK) explicitly telling Claude it cannot modify its own code, restart services, or debug itself.
- **AI news hallucinated** — Grok news source: temperature set to 0, search mode forced to `"on"`, system prompt requires source links. Response is now validated for search citations — if none found, returns "quiet day" instead of hallucinated news.

### Improvements
- **API budget default raised to $15** — `.env.example` now recommends $15 and includes budget guidance ($5 light / $15 moderate / $50+ heavy).
- **deploy.sh is PM2-aware** — Checks for PM2 and uses `pm2 restart` when available, falls back to `nohup` otherwise. No more conflict between PM2 process management and deploy script.
- **DONE tag instructions tightened** — System prompt now instructs Claude to only use `[DONE:]` when the user explicitly states completion, and to use the full goal text.
- **Added `gobot-master/` to .gitignore** — Prevents accidental commits of stale directory copies.

### Documentation
- **VPS Hardening section** in `docs/troubleshooting.md`:
  - fail2ban lockout recovery (how to unban via hosting panel)
  - SSH key best practices (no passphrase for server keys, IdentitiesOnly)
  - UFW firewall rules for the bot
  - API budget guidance with cost tiers

### Updated Files
- `src/lib/voice.ts` — Fallback context + logging for empty Supabase data
- `src/vps-gateway.ts` — `processedCallIds` dedup for polling + webhook
- `src/morning-briefing.ts` — Dedup check via `checkin-state.json`
- `src/lib/memory.ts` — Min 5-char requirement + logging for DONE/CANCEL tags
- `src/lib/anthropic-processor.ts` — LIMITATIONS section in system prompt, tightened DONE instructions
- `src/lib/agent-session.ts` — LIMITATIONS section in Agent SDK system prompt
- `src/lib/data-sources/sources/grok-news.ts` — Temp 0, search forced on, citation validation
- `.env.example` — Budget raised to $15, added usage guidance
- `deploy.sh` — PM2-aware restart
- `docs/troubleshooting.md` — VPS hardening section
- `.gitignore` — Added `gobot-master/`

### Compatibility
- Fully backward compatible. No config changes required.
- Existing `.env` files with `DAILY_API_BUDGET=5.00` continue to work (the change is only in `.env.example` for new setups).

---

## v2.3.0 — 2026-02-12

**Call-to-Task Auto-Execution**

- **Auto-task from calls** — When you end a phone call with the bot, it now detects actionable tasks in the transcript (e.g. "create a presentation", "research X") and automatically starts executing them. You'll see a "Starting task from call" notification followed by live progress updates in Telegram.
- **Works everywhere** — Task auto-execution routes through the same hybrid pipeline: Mac-local (Claude Code, free) when awake, VPS (Anthropic API) when offline.
- **Call summary improvements (Mac)** — Mac-initiated calls now get a proper summary sent to Telegram (previously only saved transcript silently).

### Updated
- `src/lib/voice.ts` — Added `extractTaskFromTranscript()` using Haiku for fast, cheap task detection
- `src/vps-gateway.ts` — Added `executeCallTask()` + `processCallTaskOnVPS()`, wired into both webhook and polling transcript paths
- `src/bot.ts` — Mac call handler now summarizes transcripts and auto-executes detected tasks via `callClaudeAndReply()`

### Compatibility
- Fully backward compatible. No config changes required.
- Requires `ANTHROPIC_API_KEY` for task extraction (uses Haiku). Without it, calls work as before (summary only, no auto-execution).

---

## v2.2.0 — 2026-02-12

**Persistent Image Storage + Formatting Fixes**

- **Persistent image storage** — Photos sent to the bot are now stored in Supabase Storage with AI-generated descriptions, tags, and optional semantic search via embeddings. Images survive restarts and can be recalled later.
- **Image cataloguing** — Claude automatically generates a structured description and tags for each image using the `[ASSET_DESC]` tag format, stored in the `assets` table.
- **Semantic image search** — With an OpenAI API key, images get vector embeddings for similarity search via the `match_assets` RPC function.
- **VPS photo support** — VPS gateway now handles photos: forwards to Mac when online, processes with Haiku vision when offline.
- **Hybrid photo forwarding** — `/process` endpoint on Mac now accepts `photoFileId` from VPS for local processing with Claude Code.
- **Markdown bold fix** — `**bold**` text now correctly renders as bold in Telegram (converted to `*bold*`).
- **Streaming progress for all message types** — Voice messages, photos, and documents now get the same live progress updates as text messages. Complex tasks show real-time tool usage regardless of how you send them.

### New Files
- `src/lib/asset-store.ts` — Upload, describe, search, and manage persistent image/file assets

### Updated
- `db/schema.sql` — Added `assets` table with pgvector embeddings, indexes, RLS policies, and `match_assets` RPC
- `src/bot.ts` — Restructured photo handler with asset persistence, added IMAGE CATALOGUING prompt, expanded `/process` endpoint for photo forwarding
- `src/vps-gateway.ts` — Added `message:photo` handler (Mac-forward + VPS-fallback), bold conversion in `sendResponse()`
- `src/lib/telegram.ts` — Added `**bold**` → `*bold*` conversion in `sendResponse()`
- `.env.example` — Added note about embedding use of `OPENAI_API_KEY`
- `CLAUDE.md` — Documented image persistence, upgrade instructions, project structure update

### Upgrade Instructions
1. `git pull && bun install`
2. Re-run `db/schema.sql` in Supabase SQL editor (safe — uses `IF NOT EXISTS`)
3. Create a Storage bucket named `gobot-assets` in Supabase Dashboard (Settings → Storage → New Bucket → public)
4. Optional: Set `OPENAI_API_KEY` in `.env` for semantic image search

### Compatibility
- Fully backward compatible. No config changes required.
- Photos work without `OPENAI_API_KEY` — semantic search is optional.
- Existing Supabase data is untouched.

---

## v2.1.0 — 2026-02-12

**Smart Routing + Streaming Progress + Agent SDK**

- **Tiered model routing** — Messages auto-classified by complexity: Haiku (simple, fast, cheap), Sonnet (medium), Opus (complex, powerful). ~60% of messages route to Haiku, saving 50-60% on VPS API costs.
- **Streaming progress updates (Mac)** — Complex tasks show real-time progress in Telegram: which tools are being used, Claude's initial plan. Progress updates in-place and disappears when done. Simple messages respond instantly.
- **Agent SDK on VPS (optional)** — Full Claude Code capabilities for Sonnet/Opus VPS requests. Loads your MCP servers, skills, hooks, and CLAUDE.md. Enable with `USE_AGENT_SDK=true`.
- **Human-in-the-loop everywhere** — Inline button confirmations work consistently across Mac (subprocess resume), VPS direct API (messages snapshot), and VPS Agent SDK (session resume).
- **Daily budget tracking (VPS)** — Set `DAILY_API_BUDGET` to cap daily spend. Auto-downgrades Opus→Sonnet when budget runs low.

### New Files
- `src/lib/model-router.ts` — Complexity classifier + tiered model selection
- `src/lib/agent-session.ts` — Agent SDK wrapper for VPS mode

### Updated
- `src/lib/claude.ts` — Added `callClaudeStreaming()` with JSONL parsing and progress callbacks
- `src/bot.ts` — Streaming progress for complex messages, model tier routing
- `src/vps-gateway.ts` — Tiered routing: Haiku→direct API, Sonnet/Opus→Agent SDK
- `src/lib/anthropic-processor.ts` — Accepts optional model parameter
- `.env.example` — Added `USE_AGENT_SDK`, `DAILY_API_BUDGET`
- `CLAUDE.md` — Documented tiered routing, Agent SDK, streaming progress

### Compatibility
- Fully backward compatible. No config changes required.
- Local-only: `git pull && bun install` — new features work automatically.
- VPS: model routing active immediately. Agent SDK is opt-in.

---

## v2.0.0 — 2026-02-09

**VPS Gateway + Hybrid Mode**

- VPS gateway mode (`bun run vps`) — Anthropic Messages API with built-in tools
- Hybrid mode — VPS forwards to local machine when awake, processes directly when offline
- Human-in-the-loop tools: ask user confirmation, phone calls
- Human-in-the-loop — Claude asks confirmation via inline Telegram buttons before acting
- Voice on VPS — transcription, TTS replies, and outbound phone calls
- Auto-deploy via GitHub webhook
- Local machine health checking with heartbeat failover

### New Files
- `src/vps-gateway.ts` — VPS entry point (webhook mode)
- `src/lib/anthropic-processor.ts` — Anthropic API with tool definitions
- `src/lib/mac-health.ts` — Local machine health checking
- `src/lib/task-queue.ts` — Human-in-the-loop task management
- `deploy.sh` — Auto-deploy script

### Updated
- `src/lib/voice.ts` — Added transcript summarization + voice agent context
- `src/lib/transcribe.ts` — Added buffer-based transcription for VPS
- `src/lib/supabase.ts` — Added async tasks + node heartbeat functions
- `db/schema.sql` — Added async_tasks + node_heartbeat tables
- `.env.example` — Full VPS/hybrid mode documentation

---

## v1.0.0 — 2026-01-15

**Core Relay + Multi-Agent System**

- Telegram relay with Claude Code CLI subprocess
- 6 specialized AI agents (General, Research, Content, Finance, Strategy, Critic)
- Forum topic routing for multi-agent system
- Persistent memory via Supabase (facts, goals, conversation history)
- Smart check-ins with context-aware decision making
- Morning briefings with goals and MCP server context
- Always-on services via launchd (macOS) / PM2 (Windows/Linux)
- Fallback LLM chain: Claude → OpenRouter → Ollama
- Voice replies (ElevenLabs TTS)
- Phone calls (ElevenLabs + Twilio)
- Audio transcription (Gemini)
- Cross-platform support (macOS, Windows, Linux)
