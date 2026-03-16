# Gobot — Always-On AI Discord Agent

> Claude Code reads this file automatically. Follow the setup phases below.
> Each phase is designed to be completed through conversation with Claude Code.

## Repository & Git Workflow

**Source of truth:** `autonomee/gobot` (GitHub organization repo)

| Repo | Role | Status |
|------|------|--------|
| `autonomee/gobot` | Main repo — all work happens here | Active |
| `godagoo/gobot` | Personal archive (was the original) | Archived, read-only |

### How to make changes (Goda):
```bash
cd ~/development/gobot
# Remote is already set to autonomee/gobot
git pull origin master
# make changes...
git add <files>
git commit -m "description"
git push origin master
```

### How community members contribute:
1. Clone: `git clone https://github.com/autonomee/gobot.git`
2. Create a branch: `git checkout -b fix/my-fix`
3. Push branch: `git push origin fix/my-fix`
4. Open PR on GitHub against `master`
5. Goda reviews and merges

### Access:
- **Autonomee Community team** (21 members) has **Write** access
- Members can push branches and create PRs
- Members **cannot** fork to personal accounts (org setting)
- Only admins (Goda, Sjotie) can merge to `master`

## What This Sets Up

An always-on Discord agent that:
- Relays your messages to Claude and sends back responses
- **Two processing engines**: Claude Code CLI (local, uses your subscription) or Anthropic API (VPS, pay-per-token). Local mode runs Anthropic's official Claude Code CLI directly. For production/always-on deployments, we recommend API keys with smart routing to manage costs. See [Anthropic's Legal and Compliance page](https://code.claude.com/docs/en/legal-and-compliance) for the latest authentication policies.
- Runs multiple specialized AI agents (Research, Content, Finance, Strategy, Critic, CTO, COO)
- **Email integration**: Send and receive email via AgentMail SDK
- **Extensible via MCP**: Connect any MCP servers you use (email, calendar, project management, etc.)
- **Human-in-the-loop**: Claude asks for confirmation via inline buttons before taking actions
- Proactively checks in with smart context awareness
- Sends morning briefings with pluggable data sources (goals, Notion, news, tasks)
- Sends weekly strategic digests (email + Discord)
- Autonomous overnight task processing
- Persists memory (facts, goals, conversation history) via Convex (Supabase fallback)
- Stores images persistently in Convex Storage with AI-generated descriptions and semantic search
- Survives reboots via cron + PM2 (Linux/VPS) or launchd (macOS)
- Falls back to OpenRouter/Ollama when Claude is unavailable
- Optional: voice replies (Gemini TTS), phone calls, audio transcription

## Prerequisites

Before starting, ensure you have:
- [ ] **macOS, Windows, or Linux**
- [ ] **Bun** runtime installed (`curl -fsSL https://bun.sh/install | bash`)
  - **Important:** After installing Bun, restart your terminal or add Bun to your PATH:
    ```bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    ```
  - To make this permanent, add those two lines to your `~/.zshrc` (macOS) or `~/.bashrc` (Linux)
- [ ] **Claude Code** CLI installed and authenticated (`claude --version`)
- [ ] A **Discord** account and server
- [ ] **Windows/Linux only**: PM2 for daemon services (`npm install -g pm2`)

## What to Expect During Setup

Claude Code will ask for permission before running commands or editing files. When you see a permission prompt:
- **"Allow tool access"** — Select "Allow for this session" or "Always allow" to let Claude Code run setup commands
- **macOS "Background Items" popup** — When launchd services start, macOS may show a notification saying *"Software from 'Jared Sumner' can run in the background"*. This is normal — Jared Sumner is the creator of the Bun runtime. Click **Allow** to let the bot services run.

---

## Phase 0: Environment Scan (Automatic, ~1 min)

> **Claude Code: Run this BEFORE starting Phase 1. Always. Even if the user says they're starting fresh.**

### What Claude Code does:

**Step 1 — Ask the user:**

"Have you previously set up a Discord bot with Claude Code, or any similar AI assistant project?"

**Step 2 — Scan regardless of answer:**

Even if the user says "no," run these checks silently. They may have forgotten, or someone else set it up on their machine.

1. **Check if this is a ZIP download (no git):**
   - Check if `.git/` directory exists in the project root
   - If NO `.git/`: this is a ZIP download. Tell the user:
     "This looks like a ZIP download. Run `bun run upgrade` to connect to the official repo — this lets you pull future updates with `git pull` without losing your config."
   - If `.git/` exists: check `git remote get-url origin` — verify it points to `autonomee/gobot`
   - If wrong remote: suggest `bun run upgrade` to fix it

2. **Check for existing `.env` file** in this project directory. If it exists, read it and catalog every variable that has a real value (not a placeholder like `your_bot_token_here`).

3. **Check for running services:**
   - macOS: `launchctl list | grep -E "com\.go\.|claude.*relay|discord"`
   - Linux/Windows: `pm2 list` (if pm2 exists)
   - Check for running Discord bot: `pgrep -f discord-bot`
   - Report any existing bot services that might conflict

4. **Check for existing database:**
   - If `CONVEX_URL` configured and working → report "Database — Convex (active)", skip Phase 2
   - If `SUPABASE_URL` configured and working → report "Database — Supabase (active)", skip Phase 2
   - If neither → Phase 2 will present the choice
   - Do NOT suggest migration unless user asks

5. **Check for existing profile:**
   - Look for `config/profile.md` in this project

**Step 3 — Report findings:**

Present a clear summary to the user:

```
ENVIRONMENT SCAN RESULTS

Git connection: ✅ Connected to autonomee/gobot / ⚠️ ZIP download (run: bun run upgrade)
Existing setup found: Yes/No

✅ Discord Bot Token — found, valid
✅ Discord Channel IDs — configured
✅ Database — Convex (active) / Supabase (active) / ❌ not configured (set up in Phase 2)
✅ User Name — "Sarah"
✅ User Timezone — "Europe/Berlin"
✅ Profile — found at [path]
❌ Anthropic API Key — not set (needed for VPS mode)
❌ Voice/TTS — not configured
❌ Fallback LLMs — not configured
❌ Email — not configured

Running services:
⚠️ Discord bot already running (PID file exists)

RECOMMENDATION:
Phases 1-3 can be skipped. Starting at Phase 4 (Agents).
```

**Step 4 — Act on findings:**

- **Reusable credentials found:** Copy them into this project's `.env`. Confirm with the user before overwriting anything. Never delete the source.
- **Existing database found:** Report which backend is active. Both are supported.
- **Conflicting services found:** Ask the user before stopping them.
- **Profile found:** Offer to review and update `config/profile.md`.
- **Nothing found:** Proceed normally from Phase 1. No special handling needed.

**Step 5 — Skip completed phases:**

Based on the scan, tell the user which phases are already done and which remain. Jump directly to the first incomplete phase.

---

## Phase 1: Discord Bot (Required, ~5 min)

### What you need to do:
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a **New Application** and name it
3. Go to **Bot** → click **Add Bot**
4. Copy the bot token
5. Enable **Message Content Intent** under Privileged Gateway Intents
6. Invite the bot to your server using the OAuth2 URL Generator:
   - Scopes: `bot`
   - Permissions: Send Messages, Read Message History, Manage Messages
7. Create channels in your Discord server:
   - `#general` — main chat
   - `#alerts` — heartbeat alerts, overdue goals, stale tasks
   - `#daily-briefing` — morning briefing delivery + weekly digest
   - `#logs` — operational logs
8. Get channel IDs: enable Developer Mode in Discord (Settings → Advanced → Developer Mode), then right-click each channel → Copy Channel ID

### What Claude Code does:
- Creates `.env` from `.env.example` if it doesn't exist
- Saves your `DISCORD_BOT_TOKEN` and channel IDs to `.env`
- Tests bot connectivity

### Tell me:
"Here's my Discord bot token: [TOKEN]" and provide your channel IDs.

---

## Phase 2: Database (Required, ~5 min)

GoBot works with either Convex or Supabase. Choose one:

| | Convex (recommended) | Supabase |
|---|---|---|
| Setup | One command | ~10 min (create project, run SQL, get 3 keys) |
| Schema | TypeScript, auto-managed | SQL, you manage manually |
| Semantic search | Built-in vector indexes | Requires edge functions |
| File storage | Built-in | Separate bucket setup |
| Data access | Dashboard + export | Full SQL + Dashboard |
| Self-hosting | No (cloud only) | Yes (open source) |
| Ecosystem | Newer, growing fast | Mature, large community |
| Free tier | Generous for single user | Generous for single user |

**Recommendation:** Convex — faster setup, auto-manages schema and search, most community members use it.

**Choose Supabase if:** You want full SQL access, plan to self-host, or already have a Supabase project.

**User says:** "I'll use Convex" or "I'll use Supabase"

### Phase 2A: Convex Setup

1. Go to [convex.dev](https://convex.dev) and create a free account
2. Claude Code runs: `npx convex dev --once --configure=new`
3. This creates your Convex deployment and gives you a `CONVEX_URL`

**What Claude Code does:**
- Runs `npx convex dev --once --configure=new` to create your Convex project
- Saves your `CONVEX_URL` to `.env`
- Deploys the schema and server functions
- Runs `bun run setup/test-convex.ts` to verify connectivity

### Phase 2B: Supabase Setup

1. Go to [supabase.com](https://supabase.com) and create a free account
2. Create a new project
3. Get your 3 keys from **Settings → API**:
   - Project URL (`SUPABASE_URL`)
   - Anon public key (`SUPABASE_ANON_KEY`)
   - Service role key (`SUPABASE_SERVICE_ROLE_KEY`)
4. Run `db/schema.sql` in the **SQL Editor** (Supabase Dashboard → SQL Editor → New Query → Paste & Run)
5. Create a Storage bucket: **Storage → New Bucket → Name: `gobot-assets` → Make public**

**What Claude Code does:**
- Saves your keys to `.env`
- Runs `bun run setup/test-supabase.ts` to verify connectivity

**Optional:** Install Supabase MCP server for direct DB access:
```bash
npx supabase mcp setup --project-ref YOUR_PROJECT_REF
```

### Switching databases later

- **Supabase → Convex:** Set up Convex, run `bun run scripts/migrate-to-convex.ts`
- **Convex → Supabase:** Set up Supabase, remove `CONVEX_URL` from `.env`
- If both are set, Convex takes priority

---

## Phase 2.5: Semantic Search (Optional, ~5 min)

Enable AI-powered memory search. Without this, the bot still works — it just uses basic text matching instead of understanding meaning.

### If using Convex:
- Get an OpenAI API key from [platform.openai.com](https://platform.openai.com)
- Claude Code sets the key as a Convex env var: `npx convex env set OPENAI_API_KEY <key>`
- Convex actions automatically generate embeddings for new messages and assets

### If using Supabase:
- Save an OpenAI or Gemini API key to `.env` as `OPENAI_API_KEY` or `GEMINI_API_KEY`
- Edge functions handle embedding generation (advanced setup)
- Basic text search works immediately without this step

### Tell me:
"Set up semantic search. My OpenAI key is [your key]" or "Skip" to use basic text search.

---

## Phase 3: Personalization (Required, ~5 min)

### What Claude Code does:
- Asks you questions about yourself (name, timezone, profession, constraints)
- Creates `config/profile.md` with your answers
- Sets `USER_TIMEZONE` in `.env`

### Tell me:
Answer the questions I'll ask about your name, timezone, and work style.

---

## Phase 4: Agent Customization (Optional, ~10 min)

The bot includes 8 pre-configured agents. You can customize them or use defaults.

### Default agents:
| Agent | Reasoning | Purpose |
|-------|-----------|---------|
| General (Orchestrator) | Adaptive | Default assistant, cross-agent coordination |
| Research | ReAct | Market intel, competitor analysis |
| Content (CMO) | RoT | Video packaging, audience growth |
| Finance (CFO) | CoT | ROI analysis, unit economics |
| Strategy (CEO) | ToT | Major decisions, long-term vision |
| Critic | Devil's Advocate | Stress-testing, pre-mortem analysis |
| CTO | Technical | Architecture, technical debt, dev velocity |
| COO | Operational | Operations, processes, team efficiency |

### Custom Agents

Create your own agents using the template:
```bash
cp src/agents/custom-agent.example.ts src/agents/my-agent.ts
```
Then register it in `src/agents/index.ts`.

### Cross-Agent Consultation

Agents can consult each other during conversations. For example, the General agent can ask Research for data, or Strategy can ask Finance for numbers. This happens automatically through `[INVOKE:agent|question]` tags in the agent's thinking.

### Board Meetings (`/board`)

The `/board` command triggers a multi-agent discussion. All configured agents weigh in on a topic sequentially, then a synthesis is generated. Useful for major decisions. Board meetings can pull live data from connected sources (Notion, GitHub) via `src/lib/board-data.ts`.

Example: `/board Should we launch a paid newsletter?`

Each agent responds from its own perspective (Research provides data, Finance runs numbers, CTO evaluates technical feasibility, Critic stress-tests, etc.).

### Tell me:
"Use defaults" or "I want to customize agents"

---

## Phase 5: Test Core Bot (Required, ~2 min)

### What Claude Code does:
- Runs `bun run discord` to start the Discord bot manually
- Tells you to send a test message in `#general`
- Verifies the bot responds
- Ctrl+C to stop

### Tell me:
"Start the test" and then confirm if you got a response on Discord.

---

## Phase 6: Scheduled Services (Optional, ~10 min)

### Available Cron Services

| Service | Schedule | Command | Description |
|---------|----------|---------|-------------|
| **Heartbeat** | Every 30 min | `bun run heartbeat:discord` | Health check, duplicate bot detection, alerts |
| **Morning Briefing** | 9am daily | `bun run briefing:discord` | Daily goals, Notion tasks, news summary |
| **Overnight Worker** | Every 2hrs (10pm-8am) | `bun run overnight` | Autonomous task processing using Claude CLI |
| **Nightly Reflection** | 11pm daily | `bun run reflection:discord` | LLM-powered daily reflection journal, stored in Convex |
| **Weekly Digest** | Monday 6am | `bun run digest` | Strategic digest emailed + posted to Discord |

### Discord Channels for Cron Services
- `#alerts` — heartbeat alerts, overdue goals, stale tasks
- `#daily-briefing` — morning briefing delivery + weekly digest
- `#logs` — operational logs

### What Claude Code does:
- Sets up crontab entries for your preferred schedule
- Ensures PATH is correctly set in crontab (Bun + Node/NVM paths required)
- Verifies services run correctly

### Crontab Notes
- Cron runs with minimal PATH — always set PATH at top of crontab
- Discord cron scripts use Discord REST API (not the full client)
- The overnight worker needs NVM path for `claude` CLI access

### Tell me:
"Set up scheduled services" or "Skip for now"

---

## Phase 6.5: Data Sources (Optional, ~5 min)

### What This Does
Morning briefings pull live data from connected services. Each source auto-enables when its env vars are set — no config files needed.

### Available Sources

| Source | Env Vars Needed | What It Shows |
|--------|----------------|---------------|
| **Goals** | _(always on)_ | Active goals from database |
| **AI News** | `XAI_API_KEY` | Top AI news via xAI Grok API |
| **Notion Tasks** | `NOTION_TOKEN`, `NOTION_DATABASE_ID` | Due and overdue tasks |
| **Notion Calendar** | `NOTION_TOKEN`, `NOTION_CALENDAR_DB_ID` | Today's calendar events from Notion |
| **Reflections** | _(always on, requires Convex)_ | Yesterday's carryforward items from nightly reflection |

### xAI Grok (AI News)
1. Get an API key from [x.ai](https://x.ai)
2. Add to `.env`: `XAI_API_KEY=your_key`

### Notion Tasks
1. Create a [Notion integration](https://www.notion.so/my-integrations)
2. Share your tasks database with the integration
3. Add to `.env`:
   ```
   NOTION_TOKEN=your_integration_token
   NOTION_DATABASE_ID=your_tasks_database_id
   ```
Your Notion database needs `Due` (date) and `Status` (status with "Done") properties.

### Custom Sources
Copy the template and implement your own:
```bash
cp src/lib/data-sources/sources/custom.example.ts src/lib/data-sources/sources/my-source.ts
```
Then import it in `src/lib/data-sources/sources/index.ts`.

### VPS / Hybrid Note
Data sources use direct REST APIs — no MCP servers needed. They work on VPS, local, and hybrid mode equally.

### Tell me:
"Set up data sources" or list which ones you want, or "Skip"

---

## Phase 7: Always-On (Required after Phase 5, ~5 min)

### What Claude Code does:
- **Linux/VPS**: Sets up crontab entries for scheduled services + PM2 for the Discord bot
- **macOS**: Runs `bun run setup:launchd -- --service all` to generate and load launchd services
- **Windows**: Runs `bun run setup:services -- --service all` to configure PM2 + scheduler
- Verifies services are running
- Explains how to check logs and restart services

### Tell me:
"Make it always-on"

---

## Phase 7.5: Email Integration (Optional, ~5 min)

### What This Does
Send and receive email via AgentMail SDK. The bot gets its own email address (e.g., `aimee@agentmail.to`).

### Setup:
1. Get an AgentMail API key
2. Add to `.env`: `AGENTMAIL_API_KEY=your_key`

### Features:
- Send email via `[EMAIL:to|subject|body]` tag in chat
- Weekly strategic digest auto-emails to configured addresses
- Email address configured in `src/lib/email.ts`

### Tell me:
"Set up email" with your AgentMail API key, or "Skip"

---

## Phase 8: Optional Integrations (~5 min each)

### Voice Replies (Gemini TTS)
- Text-to-speech for voice message responses using Gemini 2.5 Flash (free tier)
- Requires: `GEMINI_API_KEY` + optional `GEMINI_TTS_VOICE` (default: Kore)
- Available voices: Zephyr, Puck, Charon, Kore, Fenrir, Leda, Aoede, Orus, and more

### Phone Calls (ElevenLabs + Twilio)
- AI can call you for urgent check-ins
- Requires: ElevenLabs agent + Twilio phone number

### Audio Transcription (Gemini)
- Transcribe voice messages before sending to Claude
- Requires: `GEMINI_API_KEY` (same key as TTS — both free)

### Fallback LLM (OpenRouter / Ollama)
- Backup responses when Claude is unavailable
- OpenRouter: cloud fallback (`OPENROUTER_API_KEY`)
- Ollama: local fallback (`OLLAMA_MODEL`)
- Resilient client auto-chains: Claude → OpenRouter → Ollama

### Tell me:
"Set up [integration name]" with your API keys, or "Skip integrations"

---

## Phase 8.5: Scheduled Tasks & Reminders (Optional, ~5 min)

Durable scheduling powered by Convex. Say "remind me at 5pm" or "check emails every morning at 9am" — tasks persist across restarts and fire even when machines are offline.

**Requires:** Convex (Phase 2A). If you're using Supabase, scheduling is not yet available.

### Setup
```bash
bun run setup:convex
```
This reuses your existing `TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_ID` from `.env` — no re-entry needed.

### Task Types
| Type | Behavior |
|------|----------|
| `reminder` | Send a Telegram notification at the scheduled time |
| `action` | Notify + include the original prompt for execution |
| `recurring` | Repeats: `daily`, `hourly`, `weekly`, `weekdays`, `every Xh`, `every Xm` |

### Architecture
- Convex `ctx.scheduler.runAt()` for durable scheduling
- `convex/scheduledTasks.ts` — backend (create, list, cancel, fire, recurrence)
- `src/lib/convex.ts` — client wrappers
- `src/lib/anthropic-processor.ts` — 3 VPS tools (gated on `CONVEX_URL`)

### Upgrade Path (Existing Users)
```bash
git pull origin master
bun install
bun run setup:convex    # if not using Convex yet
npx convex dev --once   # if already using Convex (deploys new table)
```

Full docs: `docs/scheduling.md`

### Tell me:
"Set up scheduled tasks" or "Skip"

---

## Phase 9: VPS Deployment (Optional, ~30 min)

### What This Does
Deploy the bot to a cloud VPS so it runs 24/7 without depending on your local machine.

| Mode | How It Works | Cost |
|------|-------------|------|
| **Local Only** | Runs on your machine using Claude Code CLI | Claude Pro to get started ($20/mo), Max for full power ($100-200/mo) |
| **VPS** (recommended for 24/7) | Same code on VPS, Claude Code CLI + API key | VPS (~$5/mo) + API costs vary by usage and model selection |
| **Hybrid** | VPS always on, forwards to local when awake | VPS + API costs + subscription |

### How VPS Works — Same Code, Full Power

The key insight: **Claude Code CLI works with an `ANTHROPIC_API_KEY` environment variable.** When set, it uses the Anthropic API (pay-per-token). Without it, Claude Code uses your subscription authentication. Both approaches are compliant — GoBot calls `claude -p` (Claude Code's official subprocess mode), not a third-party API client. You still get ALL Claude Code features:

- **MCP servers** — whatever you've configured (email, Notion, databases, etc.)
- **Skills** — Your custom Claude Code skills (presentations, research, etc.)
- **Hooks** — Pre/post tool execution hooks
- **CLAUDE.md** — Project instructions loaded automatically
- **Built-in tools** — WebSearch, Read, Write, Bash, etc.

This means: **clone the repo on VPS, install Claude Code, set your API key, and run `bun run discord`.** Same experience as local. One codebase everywhere.

### Tiered Model Routing

All processing paths now include intelligent model routing that classifies message complexity:

| Tier | Model | When | Response Time |
|------|-------|------|--------------|
| **Haiku** | claude-haiku-4-5 | Greetings, status checks, short questions | 2-5s |
| **Sonnet** | claude-sonnet-4-5 | Medium tasks, unclear complexity | 5-15s |
| **Opus** | claude-opus-4-6 | Research, analysis, strategy, long writing | 15-60s |

- **VPS mode:** Routing selects the actual model. Haiku uses direct API (fast), Sonnet/Opus use Agent SDK when enabled.
- **Budget tracking:** Daily cost limit (`DAILY_API_BUDGET`, default $5). Auto-downgrades Opus→Sonnet when budget runs low.

### VPS Gateway + Agent SDK

The VPS gateway (`src/vps-gateway.ts`) supports two processing modes:

**Direct API (default):** Anthropic Messages API with 2 tools (ask_user, phone_call). Fast (2-5s) but limited capabilities. Used for all Haiku requests and when Agent SDK is disabled.

**Agent SDK (`USE_AGENT_SDK=true`):** Full Claude Code capabilities on VPS for Sonnet/Opus requests. The Agent SDK spawns a Claude Code subprocess that loads:
- Your `CLAUDE.md` (project instructions)
- Your MCP servers (from Claude Code settings via `settingSources: ["user", "project"]`)
- Your skills and hooks
- Built-in tools (Read, Write, Bash, WebSearch, etc.)
- Session persistence for HITL resume

To enable: set `USE_AGENT_SDK=true` in your VPS `.env`. Requires `@anthropic-ai/claude-agent-sdk` (installed via `bun install`).

### Hybrid Mode

VPS catches messages 24/7. When your local machine is awake, forward messages there — local uses Claude Code with your subscription, keeping API costs down. When your machine sleeps, VPS handles it with its own Claude Code + API key.

### What you need:
1. **A VPS** — Any provider works. [Hostinger](https://hostinger.com?REFERRALCODE=1GODA06) is recommended (promo code **GODAGO** for discount)
2. **Anthropic API key** — From [console.anthropic.com](https://console.anthropic.com)
3. **Claude Code CLI** — Installed on your VPS (`npm install -g @anthropic-ai/claude-code`)

### What Claude Code does:
- Walks you through provisioning and hardening the VPS (SSH keys, UFW, fail2ban)
- Installs Bun and Claude Code CLI
- Clones your repo from GitHub
- Sets up `.env` with `ANTHROPIC_API_KEY` + database credentials
- Configures MCP servers on VPS (same ones you use locally)
- Configures PM2 for process management
- Sets up GitHub webhook for auto-deploy (optional)

### VPS .env setup:
```bash
# Required for VPS — enables pay-per-token API access
ANTHROPIC_API_KEY=sk-ant-api03-your_key_here

# Discord credentials
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_CHANNEL_GENERAL=channel_id
DISCORD_CHANNEL_ALERTS=channel_id
DISCORD_CHANNEL_BRIEFING=channel_id
DISCORD_CHANNEL_LOGS=channel_id

# Database — use same backend as local
# Convex:
CONVEX_URL=https://your-deployment.convex.cloud
# Supabase:
# SUPABASE_URL=https://your-project.supabase.co
# SUPABASE_ANON_KEY=your_anon_key
```

### Tell me:
"Deploy to VPS" and I'll walk you through it.

---

## Phase 10: Verification (Required, ~2 min)

### What Claude Code does:
- Runs `bun run setup:verify` for full health check
- Tests all configured services
- Reports pass/fail for each component

### Tell me:
"Run verification"

---

## Giving Claude "Hands" — MCP Servers & Tool Access

Claude Code on its own is a brain — it can think and reason, but it can't interact
with the outside world. **MCP servers** and **direct APIs** are what give it "hands"
to actually do things:

```
Claude Code (brain)
  │
  ├── MCP Server: [email]      → read, send, reply to emails
  ├── MCP Server: [notion]     → tasks, calendar, databases
  ├── MCP Server: [databases]  → query tasks, update records
  ├── MCP Server: Convex       → persistent memory, goals, facts
  ├── MCP Server: [your tools] → whatever MCP servers you connect
  │
  └── Built-in Tools           → web search, file read, code execution
```

**How to connect MCP servers:** Follow the setup guides for each MCP server you want.
Once configured in your Claude Code settings, the bot automatically has access to them
because it spawns Claude Code subprocesses that inherit your MCP configuration.

**Local mode:** Claude Code CLI uses your MCP servers directly.
**VPS mode:** Uses Anthropic API with database context. External service access
happens when your local machine handles the message (hybrid mode).

## Tag System

The bot recognises special tags in messages for quick actions:

| Tag | Action | Example |
|-----|--------|---------|
| `[GOAL:]` | Create a new goal | `[GOAL: Launch newsletter by March]` |
| `[DONE:]` | Mark a goal as complete | `[DONE: Launch newsletter]` |
| `[CANCEL:]` | Cancel a goal | `[CANCEL: Newsletter launch]` |
| `[REMEMBER:]` | Store a fact in memory | `[REMEMBER: API key rotates monthly]` |
| `[FORGET:]` | Remove a stored fact | `[FORGET: old API key schedule]` |
| `[SEND:#channel\|msg]` | Post to another Discord channel | `[SEND:#alerts\|Server restarted]` |
| `[EMAIL:to\|subject\|body]` | Send email via AgentMail | `[EMAIL:bob@co.com\|Update\|Here's the report]` |
| `[OVERNIGHT:task]` | Queue a task for autonomous overnight processing | `[OVERNIGHT: Research competitor pricing]` |

## Project Structure

```
convex/                  # Convex backend (primary database)
  schema.ts              # Table definitions with vector indexes
  messages.ts            # Message CRUD + semantic search
  memory.ts              # Facts, goals, memory context
  logs.ts                # Observability logging
  asyncTasks.ts          # Human-in-the-loop task management
  nodeHeartbeat.ts       # Hybrid mode health tracking
  assets.ts              # File/image storage with Convex Storage
  knowledge.ts           # Structured knowledge base
  scheduledTasks.ts      # Durable scheduled tasks (reminders, recurring)
  reflections.ts         # Nightly reflection journal storage
  embeddings.ts          # OpenAI embedding generation (actions)
  embeddingPatches.ts    # Embedding repair functions
  callTranscripts.ts     # Voice call transcript storage
  migrations.ts          # Schema versioning + migrations
  http.ts                # HTTP webhook routes (future)
scripts/
  migrate-to-convex.ts   # Supabase → Convex data migration
src/
  discord-bot.ts         # Discord bot (main service, PID-file guarded)
  discord-briefing.ts    # Discord morning briefing (cron)
  discord-heartbeat.ts   # Discord heartbeat/watchdog (cron, kills duplicates)
  discord-overnight.ts   # Autonomous overnight task runner (cron)
  discord-weekly-digest.ts # Weekly strategic digest (email + Discord, cron)
  discord-reflection.ts  # Nightly reflection journal (cron)
  cli-chat.ts            # CLI chat interface
  bot.ts                 # Legacy Telegram relay daemon (local mode, polling)
  vps-gateway.ts         # VPS gateway (webhook mode, Anthropic API)
  smart-checkin.ts       # Proactive check-ins
  morning-briefing.ts    # Morning briefing orchestration
  watchdog.ts            # Health monitor
  lib/                   # Shared utilities
    env.ts               # Environment loader
    discord.ts           # Discord REST API helpers, cross-channel messaging
    email.ts             # AgentMail SDK integration
    claude.ts            # Claude Code subprocess (local mode) + streaming progress
    anthropic-processor.ts  # Anthropic API processor (VPS mode, direct API)
    agent-session.ts     # Agent SDK processor (VPS mode, full Claude Code)
    model-router.ts      # Complexity classifier + tiered model selection
    resilient-client.ts  # Fallback LLM chain (Claude → OpenRouter → Ollama)
    mac-health.ts        # Local machine health checking (hybrid mode)
    task-queue.ts        # Human-in-the-loop task management
    asset-store.ts       # Persistent image/file storage with AI descriptions
    board-data.ts        # Board meeting live data aggregation
    convex.ts            # Database client (Convex primary, Supabase fallback)
    supabase.ts          # Supabase client (used as fallback)
    memory.ts            # Facts, goals, intents
    knowledge-base.ts    # Structured knowledge storage
    fallback-llm.ts      # Backup LLM chain
    capabilities.ts      # Agent capability definitions
    cross-agent.ts       # Inter-agent consultation
    bot-registry.ts      # Multi-bot token management
    telegram.ts          # Telegram API helpers (legacy)
    voice.ts             # Gemini TTS + ElevenLabs calls + context
    transcribe.ts        # Gemini transcription (file + buffer)
    gobotbook.ts         # GobotBook integration (comments + LLM summaries)
    data-sources/        # Pluggable morning briefing data
      types.ts           # DataSource interface
      registry.ts        # Register, discover, fetch all
      google-auth.ts     # Google OAuth token refresh (unused, from upstream)
      index.ts           # Module exports
      sources/           # Individual data sources
        goals.ts         # Active goals from database
        grok-news.ts     # AI news via xAI Grok
        gmail.ts         # Unread emails (unused, from upstream)
        calendar.ts      # Google Calendar events (unused, from upstream)
        notion-tasks.ts  # Due/overdue tasks
        notion-calendar.ts # Notion calendar events
        reflections.ts   # Yesterday's reflection carryforward
        custom.example.ts # Template for custom sources
        index.ts         # Source registry
  agents/                # Multi-agent system
    base.ts              # Agent interface + routing
    index.ts             # Registry
    general.ts           # Orchestrator (adaptive)
    research.ts          # ReAct reasoning
    content.ts           # RoT reasoning (CMO)
    finance.ts           # CoT reasoning (CFO)
    strategy.ts          # ToT reasoning (CEO)
    critic.ts            # Devil's advocate
    cto.ts               # Technical leadership (board meetings)
    coo.ts               # Operational leadership (board meetings)
    custom-agent.example.ts # Template for custom agents
config/
  profile.md             # User personalization
  profile.example.md     # Profile template
  schedule.example.json  # Default schedule template
  pending-proposal.json  # Feature proposals for briefing delivery
db/
  schema.sql             # Supabase database schema
deploy.sh               # Auto-deploy script (VPS)
vps-convex-client.ts     # Standalone Convex client for VPS
index.html               # Web dashboard
setup/
  install.ts             # Prerequisites checker + installer
  upgrade.ts             # Git remote + schema upgrade
  configure-launchd.ts   # macOS launchd plist generator
  configure-services.ts  # Windows/Linux PM2 + scheduler
  verify.ts              # Full health check
  test-telegram.ts       # Telegram connectivity test (legacy)
  test-convex.ts         # Convex connectivity test
  test-supabase.ts       # Supabase connectivity test
  setup-google-oauth.ts  # Google OAuth token setup (unused, from upstream)
  configure-convex.ts    # Convex setup for scheduled tasks
  uninstall.ts           # Clean removal (cross-platform)
launchd/
  templates/             # Plist templates for services (macOS)
logs/                    # Service log files
docs/
  architecture.md        # Architecture deep dive
  faq.md                 # Frequently asked questions
  scheduling.md          # Scheduled tasks & reminders docs
  troubleshooting.md     # Common issues and fixes
```

## Runtime State Files

These are generated at runtime and should not be committed:

| File | Purpose |
|------|---------|
| `discord-bot.pid` | PID guard — prevents duplicate bot instances |
| `discord-bot-health.json` | Bot health status for heartbeat checks |
| `briefing-state.json` | Morning briefing delivery state |
| `overnight-state.json` | Overnight task queue and progress |
| `reflection-state.json` | Nightly reflection dedup state |
| `session-state-discord.json` | Discord session persistence |
| `session-state.json` | CLI/legacy session persistence |
| `checkin-state.json` | Smart check-in state |
| `meeting-actions-state.json` | Board meeting actions state |
| `gobotbook-state.json` | GobotBook state |

## Useful Commands

```bash
# --- Discord Bot ---
bun run discord                    # Start Discord bot
bun run chat                       # CLI chat interface

# --- Cron Services ---
bun run heartbeat:discord          # Run heartbeat check
bun run briefing:discord           # Run morning briefing
bun run overnight                  # Run overnight worker
bun run digest                     # Run weekly digest
bun run reflection:discord         # Run nightly reflection

# --- Legacy (Telegram) ---
bun run start                      # Telegram polling mode
bun run vps                        # VPS gateway (webhook mode)
bun run checkin                    # Smart check-in
bun run briefing                   # Telegram morning briefing

# --- Setup & Testing ---
bun run setup                      # Prerequisites checker
bun run setup:verify               # Full health check
bun run setup:launchd              # macOS launchd services
bun run setup:services             # PM2 + scheduler (Windows/Linux)
bun run test:convex                # Test Convex connectivity
bun run test:supabase              # Test Supabase connectivity
bun run migrate:convex             # Migrate Supabase → Convex
bun run upgrade                    # Upgrade to official repo
bun run uninstall                  # Clean removal

# --- VPS (PM2) ---
pm2 start src/discord-bot.ts --name go-bot --interpreter bun  # Start
pm2 status                         # Check service status
pm2 restart go-bot                 # Restart
pm2 logs go-bot --lines 50        # View logs

# --- Process Management ---
pgrep -f discord-bot               # Check if bot is running
cat discord-bot.pid                # Check PID file
kill $(cat discord-bot.pid)        # Stop bot
```

## Troubleshooting

See `docs/troubleshooting.md` for common issues and fixes.

### Quick Fixes

**Bot not responding:**
1. Check if the bot is running: `pgrep -f discord-bot` or `pm2 status`
2. Check logs: `tail -50 logs/discord-bot.log`
3. Check for duplicate instances: the heartbeat script auto-kills duplicates
4. Restart: `kill $(cat discord-bot.pid) && bun run discord`

**Claude subprocess failures:**
- JSON responses are often wrapped in ```json``` fences -- the bot strips these automatically
- Always kill subprocesses on timeout to avoid zombie processes
- Check `claude --version` to ensure CLI is still authenticated
- **Key lesson:** Never use Claude subprocesses to fetch data (email, calendar, etc.) from background scripts. Claude initializes all MCP servers on startup (60-180s). Use direct REST APIs instead -- see `docs/architecture.md`

**Cron jobs not running:**
- Check crontab: `crontab -l`
- Ensure PATH is set at top of crontab (Bun + Node/NVM paths)
- Discord cron scripts use REST API — they don't need the full Discord client
- The overnight worker needs NVM path for `claude` CLI access
- Check logs in `logs/` directory

**VPS gateway not processing:**
- Check `ANTHROPIC_API_KEY` is set and valid
- Check PM2 logs: `pm2 logs go-bot --lines 50`
- For hybrid mode: verify `MAC_HEALTH_URL` is reachable from VPS

**VPS API errors (401/403):**
- If using external APIs on VPS, ensure your tokens/keys are still valid
- Refresh tokens can expire if unused for 6+ months

**Human-in-the-loop buttons not working:**
- Ensure `async_tasks` table exists in database
- Stale tasks auto-remind after 2 hours

**Cannot test Claude subprocess from inside Claude session:**
- This is expected — nested Claude sessions are not supported
- Test Claude CLI separately in a terminal
