/**
 * MCPManager — Model-Agnostic MCP Tool Access
 *
 * Boots MCP servers at startup, collects tool schemas, and provides
 * tools in both Anthropic and OpenAI formats. This enables MCP tool
 * access with ANY LLM — not just Claude Code.
 *
 * Config priority:
 * 1. config/mcp-servers.json (GoBot-specific)
 * 2. MCP_CONFIG_PATH env var
 * 3. ~/.claude.json (auto-filter to bun-based servers only)
 *
 * Only bun-based servers are started to avoid zombie processes
 * from npx-spawned servers (learned 2026-02-23).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

// ============================================================
// TYPES
// ============================================================

interface ServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface ConnectedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: MCPToolDef[];
}

interface MCPToolDef {
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

// ============================================================
// MCP MANAGER
// ============================================================

class MCPManager {
  private servers: Map<string, ConnectedServer> = new Map();
  private allTools: MCPToolDef[] = [];
  private toolToServer: Map<string, string> = new Map();
  private initialized = false;
  private cleanupRegistered = false;

  /**
   * Initialize — read config, start servers, collect tools.
   * Safe to call multiple times (idempotent).
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const configs = this.loadConfigs();
    if (Object.keys(configs).length === 0) {
      console.log("[MCPManager] No MCP servers configured");
      this.initialized = true;
      return;
    }

    console.log(
      `[MCPManager] Starting ${Object.keys(configs).length} MCP servers...`
    );

    // Start all servers concurrently
    const entries = Object.entries(configs);
    const results = await Promise.allSettled(
      entries.map(([name, config]) => this.startServer(name, config))
    );

    // Report results
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        console.error(
          `[MCPManager] ❌ ${entries[i][0]}: ${(results[i] as PromiseRejectedResult).reason}`
        );
      }
    }

    console.log(
      `[MCPManager] ✅ ${this.servers.size}/${entries.length} servers, ${this.allTools.length} tools available`
    );

    this.initialized = true;

    // Register cleanup once
    if (!this.cleanupRegistered) {
      this.cleanupRegistered = true;
      const cleanup = () => this.shutdown();
      process.on("exit", cleanup);
      process.on("SIGINT", () => {
        cleanup();
        process.exit(0);
      });
      process.on("SIGTERM", () => {
        cleanup();
        process.exit(0);
      });
    }
  }

  /**
   * Start a single MCP server and collect its tools.
   */
  private async startServer(
    name: string,
    config: ServerConfig
  ): Promise<void> {
    const resolvedEnv = this.resolveEnv(config.env || {});

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...resolvedEnv } as Record<string, string>,
    });

    const client = new Client({
      name: `gobot-${name}`,
      version: "1.0.0",
    });

    // Connect with timeout
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout (10s)")), 10000)
      ),
    ]);

    // List tools
    const toolsResult = await client.listTools();
    const tools: MCPToolDef[] = (toolsResult.tools || []).map((t: any) => ({
      serverName: name,
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema || { type: "object", properties: {} },
    }));

    // Register server and its tools
    this.servers.set(name, { name, client, transport, tools });
    for (const tool of tools) {
      this.allTools.push(tool);
      this.toolToServer.set(tool.name, name);
    }

    console.log(
      `[MCPManager] ✅ ${name}: ${tools.length} tools (${tools.map((t) => t.name).join(", ")})`
    );
  }

  /**
   * Call a tool by name. Routes to the correct server.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: string; isError: boolean }> {
    const serverName = this.toolToServer.get(toolName);
    if (!serverName) {
      return {
        content: JSON.stringify({ error: `Unknown MCP tool: ${toolName}` }),
        isError: true,
      };
    }

    const server = this.servers.get(serverName);
    if (!server) {
      return {
        content: JSON.stringify({
          error: `Server ${serverName} not connected`,
        }),
        isError: true,
      };
    }

    try {
      console.log(
        `[MCPManager] Calling ${serverName}/${toolName}(${JSON.stringify(args).substring(0, 200)})`
      );

      const result = await server.client.callTool({
        name: toolName,
        arguments: args,
      });

      // Flatten content blocks to string
      const text =
        (result.content as any[])
          ?.map((c: any) => c.text || JSON.stringify(c))
          .join("\n") || "OK";

      return { content: text, isError: !!result.isError };
    } catch (err: any) {
      console.error(`[MCPManager] Tool ${toolName} error:`, err.message);
      return {
        content: JSON.stringify({ error: err.message }),
        isError: true,
      };
    }
  }

  /**
   * Get all tools in Anthropic Tool format.
   */
  getAnthropicTools(): Anthropic.Tool[] {
    return this.allTools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: "object" as const,
        ...(t.inputSchema as any),
      },
    }));
  }

  /**
   * Get all tools in OpenAI function calling format.
   */
  getOpenAITools(): OpenAITool[] {
    return this.allTools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: "object",
          ...(t.inputSchema as any),
        },
      },
    }));
  }

  /**
   * Check if a tool name belongs to MCP (vs hard-coded tools).
   */
  hasTool(name: string): boolean {
    return this.toolToServer.has(name);
  }

  /**
   * Number of available tools.
   */
  get toolCount(): number {
    return this.allTools.length;
  }

  /**
   * Whether MCPManager has been initialized.
   */
  get isReady(): boolean {
    return this.initialized;
  }

  /**
   * Status summary for logging/diagnostics.
   */
  getStatus(): string {
    if (!this.initialized) return "not initialized";
    if (this.servers.size === 0) return "no servers";
    const serverList = Array.from(this.servers.entries())
      .map(([name, s]) => `${name}(${s.tools.length})`)
      .join(", ");
    return `${this.servers.size} servers, ${this.allTools.length} tools: ${serverList}`;
  }

  /**
   * Shut down all MCP server connections and kill processes.
   */
  shutdown(): void {
    if (this.servers.size === 0) return;
    console.log(`[MCPManager] Shutting down ${this.servers.size} servers...`);

    this.servers.forEach((server, name) => {
      try {
        server.client.close();
      } catch {
        // Ignore cleanup errors
      }
    });

    this.servers.clear();
    this.allTools = [];
    this.toolToServer.clear();
    this.initialized = false;
  }

  // ============================================================
  // CONFIG LOADING
  // ============================================================

  private loadConfigs(): Record<string, ServerConfig> {
    // Priority 1: GoBot-specific config
    const gobotConfig = resolve(process.cwd(), "config", "mcp-servers.json");
    if (existsSync(gobotConfig)) {
      try {
        const raw = JSON.parse(readFileSync(gobotConfig, "utf-8"));
        console.log(`[MCPManager] Config: ${gobotConfig}`);
        return raw.servers || {};
      } catch (err: any) {
        console.error(
          `[MCPManager] Bad config ${gobotConfig}: ${err.message}`
        );
      }
    }

    // Priority 2: MCP_CONFIG_PATH env var
    const envPath = process.env.MCP_CONFIG_PATH;
    if (envPath && existsSync(envPath)) {
      try {
        const raw = JSON.parse(readFileSync(envPath, "utf-8"));
        console.log(`[MCPManager] Config: ${envPath}`);
        return raw.servers || raw.mcpServers || {};
      } catch (err: any) {
        console.error(`[MCPManager] Bad config ${envPath}: ${err.message}`);
      }
    }

    // Priority 3: Read ~/.claude.json, auto-filter to bun-based servers
    const claudeConfig = resolve(
      process.env.HOME || "/root",
      ".claude.json"
    );
    if (existsSync(claudeConfig)) {
      try {
        const raw = JSON.parse(readFileSync(claudeConfig, "utf-8"));
        const mcpServers = raw.mcpServers || {};
        const bunOnly: Record<string, ServerConfig> = {};

        for (const [name, config] of Object.entries(mcpServers) as [
          string,
          any,
        ][]) {
          // Only start bun-based servers (npx = zombie risk)
          if (config.command?.includes("bun")) {
            bunOnly[name] = {
              command: config.command,
              args: config.args || [],
              env: config.env || {},
            };
          }
        }

        if (Object.keys(bunOnly).length > 0) {
          console.log(
            `[MCPManager] Config: ${claudeConfig} (${Object.keys(bunOnly).length} bun servers)`
          );
          return bunOnly;
        }
      } catch (err: any) {
        console.error(
          `[MCPManager] Bad config ${claudeConfig}: ${err.message}`
        );
      }
    }

    return {};
  }

  /**
   * Resolve env var references like ${VAR_NAME} from process.env.
   */
  private resolveEnv(env: Record<string, string>): Record<string, string> {
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      const match = value.match(/^\$\{(.+)\}$/);
      if (match) {
        resolved[key] = process.env[match[1]] || value;
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }
}

// ============================================================
// SINGLETON
// ============================================================

export const mcpManager = new MCPManager();
