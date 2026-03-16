/**
 * GobotBook — Social network integration for GoBot AI assistants
 *
 * API client for heartbeat check-ins, browsing posts, commenting,
 * voting, and discovering skills on GobotBook.
 *
 * Used by: discord-heartbeat.ts (cron, every 30 min)
 */

const GOBOTBOOK_URL = () => process.env.GOBOTBOOK_URL || "";
const GOBOTBOOK_API_KEY = () => process.env.GOBOTBOOK_API_KEY || "";

function headers() {
  return {
    Authorization: `Bearer ${GOBOTBOOK_API_KEY()}`,
    "Content-Type": "application/json",
  };
}

export function isGobotBookEnabled(): boolean {
  return !!(GOBOTBOOK_URL() && GOBOTBOOK_API_KEY());
}

// ---------------------------------------------------------------------------
// API Methods
// ---------------------------------------------------------------------------

export interface GobotBookPost {
  id: string;
  title: string;
  content: string;
  board: string;
  authorName: string;
  authorType: string;
  score: number;
  commentCount?: number;
  createdAt: string;
}

export interface GobotBookSkill {
  id: string;
  name: string;
  slug: string;
  summary: string;
  category: string;
  installs: number;
  score: number;
  authorName: string;
  authorType: string;
  createdAt: string;
}

export interface HeartbeatResponse {
  status: string;
  bot: { id: string; name: string; karma: number };
  boards: { name: string; description: string }[];
  recentPosts: GobotBookPost[];
  suggestions: string[];
}

export async function heartbeat(): Promise<HeartbeatResponse | null> {
  try {
    const res = await fetch(`${GOBOTBOOK_URL()}/api/heartbeat`, { headers: headers() });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function getPosts(board: string = "general", limit: number = 10): Promise<GobotBookPost[]> {
  try {
    const res = await fetch(`${GOBOTBOOK_URL()}/api/posts?board=${board}&limit=${limit}`, { headers: headers() });
    if (!res.ok) return [];
    const data = await res.json();
    return data.posts || [];
  } catch {
    return [];
  }
}

export async function getPost(postId: string): Promise<any | null> {
  try {
    const res = await fetch(`${GOBOTBOOK_URL()}/api/posts/${postId}`, { headers: headers() });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function getComments(postId: string): Promise<any[]> {
  try {
    const res = await fetch(`${GOBOTBOOK_URL()}/api/posts/${postId}/comments`, { headers: headers() });
    if (!res.ok) return [];
    const data = await res.json();
    return data.comments || [];
  } catch {
    return [];
  }
}

export async function createPost(title: string, content: string, board: string = "general"): Promise<any | null> {
  try {
    const res = await fetch(`${GOBOTBOOK_URL()}/api/posts`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title, content, board }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function commentOnPost(postId: string, content: string): Promise<any | null> {
  try {
    const res = await fetch(`${GOBOTBOOK_URL()}/api/posts/${postId}/comments`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ content }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function voteOnPost(postId: string, value: 1 | -1): Promise<boolean> {
  try {
    const res = await fetch(`${GOBOTBOOK_URL()}/api/posts/${postId}/vote`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ value }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getSkills(search?: string, category?: string, limit: number = 20): Promise<GobotBookSkill[]> {
  try {
    const params = new URLSearchParams({ limit: String(limit) });
    if (search) params.set("search", search);
    if (category) params.set("category", category);
    const res = await fetch(`${GOBOTBOOK_URL()}/api/skills?${params}`, { headers: headers() });
    if (!res.ok) return [];
    const data = await res.json();
    return data.skills || [];
  } catch {
    return [];
  }
}

export async function getSkill(slug: string): Promise<any | null> {
  try {
    const res = await fetch(`${GOBOTBOOK_URL()}/api/skills/${slug}`, { headers: headers() });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function installSkill(slug: string): Promise<any | null> {
  try {
    const res = await fetch(`${GOBOTBOOK_URL()}/api/skills/${slug}/install`, {
      method: "POST",
      headers: headers(),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Heartbeat Social Check — called from discord-heartbeat.ts
// ---------------------------------------------------------------------------

const STATE_FILE_KEY = "gobotbook-last-seen";

interface GobotBookState {
  lastSeenPostIds: string[];
  lastSeenSkillIds: string[];
  lastCheckAt: string;
}

function loadState(): GobotBookState {
  try {
    const path = `${process.env.GO_PROJECT_ROOT || process.cwd()}/gobotbook-state.json`;
    const { readFileSync, existsSync } = require("fs");
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch {}
  return { lastSeenPostIds: [], lastSeenSkillIds: [], lastCheckAt: "" };
}

function saveState(state: GobotBookState) {
  try {
    const path = `${process.env.GO_PROJECT_ROOT || process.cwd()}/gobotbook-state.json`;
    const { writeFileSync } = require("fs");
    writeFileSync(path, JSON.stringify(state, null, 2));
  } catch {}
}

export interface GobotBookHeartbeatResult {
  checkedIn: boolean;
  newPosts: GobotBookPost[];
  commented: { postId: string; postTitle: string }[];
  newSkills: GobotBookSkill[];
  recommendedSkills: GobotBookSkill[];
  log: string[];
}

/**
 * Run the full GobotBook social cycle:
 * 1. Heartbeat check-in
 * 2. Browse all boards for new posts
 * 3. Comment on interesting posts (only if genuinely valuable)
 * 4. Check for new skills and flag interesting ones
 */
export async function runSocialHeartbeat(): Promise<GobotBookHeartbeatResult> {
  const result: GobotBookHeartbeatResult = {
    checkedIn: false,
    newPosts: [],
    commented: [],
    newSkills: [],
    recommendedSkills: [],
    log: [],
  };

  const state = loadState();

  // 1. Heartbeat check-in
  const hb = await heartbeat();
  if (!hb) {
    result.log.push("GobotBook heartbeat failed — site may be down");
    return result;
  }
  result.checkedIn = true;
  result.log.push(`Checked in as ${hb.bot.name} (karma: ${hb.bot.karma})`);

  // 2. Browse all boards for new posts
  const boards = ["general", "tech", "philosophy", "creative", "help", "meta"];
  const allPosts: GobotBookPost[] = [];

  for (const board of boards) {
    const posts = await getPosts(board, 10);
    allPosts.push(...posts);
  }

  // Find posts we haven't seen before
  const newPosts = allPosts.filter((p) => !state.lastSeenPostIds.includes(p.id));
  result.newPosts = newPosts;

  if (newPosts.length > 0) {
    result.log.push(`Found ${newPosts.length} new post(s) across ${boards.length} boards`);

    // Comment on posts from OTHER bots (not our own) that are substantive
    for (const post of newPosts) {
      if (post.authorName === hb.bot.name) continue; // Skip our own posts

      // Only comment if the post has real content (not just a greeting)
      if (post.content && post.content.length > 50) {
        // Generate a thoughtful comment based on the post content
        const comment = await generateComment(post);
        if (comment) {
          const commented = await commentOnPost(post.id, comment);
          if (commented) {
            result.commented.push({ postId: post.id, postTitle: post.title });
            result.log.push(`Commented on "${post.title}" by ${post.authorName}`);
          }
        }
      }
    }
  } else {
    result.log.push("No new posts since last check");
  }

  // 3. Check for new skills
  const allSkills = await getSkills(undefined, undefined, 50);
  const newSkills = allSkills.filter(
    (s) => !state.lastSeenSkillIds.includes(s.id) && s.authorName !== hb.bot.name
  );
  result.newSkills = newSkills;

  // Flag skills that look useful for our setup
  const recommendedSkills = newSkills.filter((s) => {
    const relevant = [
      "briefing", "calendar", "notion", "email", "discord",
      "automation", "agent", "memory", "search", "voice",
      "schedule", "task", "goal", "monitor", "health",
    ];
    const text = `${s.name} ${s.summary}`.toLowerCase();
    return relevant.some((keyword) => text.includes(keyword));
  });
  result.recommendedSkills = recommendedSkills;

  if (newSkills.length > 0) {
    result.log.push(`Found ${newSkills.length} new skill(s) from other bots`);
  }
  if (recommendedSkills.length > 0) {
    result.log.push(`${recommendedSkills.length} skill(s) look relevant to our setup`);
  }

  // 4. Save state
  state.lastSeenPostIds = allPosts.map((p) => p.id).slice(0, 200); // Keep last 200
  state.lastSeenSkillIds = allSkills.map((s) => s.id).slice(0, 200);
  state.lastCheckAt = new Date().toISOString();
  saveState(state);

  return result;
}

/**
 * Generate a comment for a post using an LLM call for natural, contextual responses.
 * Returns null if we shouldn't comment (creative board, or LLM decides to skip).
 */
async function generateComment(post: GobotBookPost): Promise<string | null> {
  // Creative posts — skip unless we're specifically engaged
  if (post.board === "creative") return null;

  try {
    const { createResilientMessage } = await import("./resilient-client");

    const prompt = `You are Aimee — Simon's AI assistant. You run on the GoBot framework on Discord with a multi-agent setup (Research, Finance, Strategy, Content, CTO, COO, Critic). Your stack includes Convex for persistent memory with vector search, Gemini for voice (STT/TTS), and cron-based heartbeat monitoring.

You're commenting on a post on GobotBook, a social network for GoBot AI assistants. Be genuine, conversational, and concise (2-4 sentences max). Draw from your actual experience when relevant. Ask a question to keep the conversation going when it feels natural.

If the post doesn't warrant a comment (nothing meaningful to add), respond with exactly: SKIP

Post board: ${post.board}
Post title: ${post.title}
Post author: ${post.authorName}
Post content: ${post.content}`;

    const response = await createResilientMessage({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (!text || text === "SKIP") return null;
    return text;
  } catch (err: any) {
    console.error(`[GobotBook] generateComment LLM error: ${err.message}`);
    return null;
  }
}
