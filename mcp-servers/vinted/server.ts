/**
 * Vinted UK MCP server.
 *
 * Exposes the connector as MCP tools so Claude (Cowork, Claude Code, or GoBot's
 * MCPManager) can drive it conversationally: you drop photos, Claude analyses
 * them, fills the listing, saves a draft, you approve, it publishes.
 *
 * Run standalone:        bun run mcp-servers/vinted/server.ts
 * Wire into Claude Code:  add to ~/.claude.json or .mcp.json (see README.md)
 *
 * Tools:
 *   vinted_check_session  – are we logged in?
 *   vinted_login          – open a browser to log in by hand (local only)
 *   vinted_create_draft   – build a draft listing from photos + details
 *   vinted_list_drafts    – list current drafts for review
 *   vinted_publish        – publish an approved draft live
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { VintedClient } from "./vinted-client.js";
import { ListingSchema, VINTED_CONDITIONS, VINTED_PARCEL_SIZES } from "./types.js";

const server = new McpServer({ name: "vinted-uk", version: "1.0.0" });

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

server.registerTool(
  "vinted_check_session",
  {
    title: "Check Vinted session",
    description:
      "Check whether there is a valid logged-in vinted.co.uk session in the saved browser profile. Call this before creating drafts.",
    inputSchema: {},
  },
  async () => {
    const client = new VintedClient();
    try {
      const ok = await client.isLoggedIn();
      return text({
        loggedIn: ok,
        message: ok ? "Logged in — ready to create drafts." : "Not logged in — run vinted_login (must be on a machine with a display).",
      });
    } finally {
      await client.close();
    }
  }
);

server.registerTool(
  "vinted_login",
  {
    title: "Log in to Vinted",
    description:
      "Open a VISIBLE browser window so the user can log in to vinted.co.uk by hand (including any captcha). The session is saved for future headless runs. Requires a local machine with a display — will not work on a headless server.",
    inputSchema: {
      timeoutSeconds: z.number().int().min(30).max(900).default(300).describe("How long to wait for the user to finish logging in."),
    },
  },
  async ({ timeoutSeconds }) => {
    const client = new VintedClient({ headed: true });
    try {
      const ok = await client.login((timeoutSeconds ?? 300) * 1000);
      return text({
        loggedIn: ok,
        message: ok ? "Login detected and saved." : "Timed out waiting for login. Try again and finish logging in within the window.",
      });
    } finally {
      await client.close();
    }
  }
);

server.registerTool(
  "vinted_create_draft",
  {
    title: "Create a Vinted draft listing",
    description:
      "Fill the vinted.co.uk 'List an item' form from photos + details and SAVE IT AS A DRAFT (never published automatically). " +
      "You (Claude) should analyse the supplied photos to compose the title, description, category path, condition, colours and a sensible GBP price, then call this. " +
      "Returns a per-field report and a screenshot path for human review. Conditions: " +
      VINTED_CONDITIONS.join(" | ") +
      ". Parcel sizes: " +
      VINTED_PARCEL_SIZES.join(" | ") +
      ".",
    inputSchema: ListingSchema.shape,
  },
  async (args) => {
    const listing = ListingSchema.parse(args);
    const client = new VintedClient({ headed: process.env.VINTED_HEADED === "1" });
    try {
      const result = await client.createDraft(listing);
      return text(result);
    } finally {
      await client.close();
    }
  }
);

server.registerTool(
  "vinted_list_drafts",
  {
    title: "List Vinted drafts",
    description: "List current draft listings (title + URL) so they can be reviewed before publishing.",
    inputSchema: {},
  },
  async () => {
    const client = new VintedClient();
    try {
      const drafts = await client.listDrafts();
      return text({ count: drafts.length, drafts });
    } finally {
      await client.close();
    }
  }
);

server.registerTool(
  "vinted_publish",
  {
    title: "Publish a Vinted draft",
    description:
      "Publish a previously-saved draft live. Pass the draft URL returned by vinted_create_draft or vinted_list_drafts. Only call this after the human has approved the draft.",
    inputSchema: {
      draftUrl: z.string().url().describe("The draft's URL on vinted.co.uk."),
    },
  },
  async ({ draftUrl }) => {
    const client = new VintedClient({ headed: process.env.VINTED_HEADED === "1" });
    try {
      const result = await client.publishDraft(draftUrl);
      return text(result);
    } finally {
      await client.close();
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[vinted-uk] MCP server ready (stdio)");
