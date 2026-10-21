import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LinkedInClient } from "./client.js";
import { organizationUrn, readConfig, type LinkedInConfig } from "./config.js";
import { LinkedInError } from "./errors.js";
import { TokenManager } from "./oauth.js";
import { sanitize } from "./sanitize.js";

/**
 * The MCP tools. Read-only: there is deliberately no publishing tool here; posting
 * goes through the approval-gated workflow in meta-mcp, which uses the library.
 */

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export interface ToolContext {
  /** Throws a ConfigError when the configuration is incomplete (the server still starts). */
  config(): LinkedInConfig;
  client(): LinkedInClient;
}

export function createContext(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): ToolContext {
  let config: LinkedInConfig | undefined;
  let client: LinkedInClient | undefined;
  const ctx: ToolContext = {
    config() {
      config ??= readConfig(env);
      return config;
    },
    client() {
      const c = ctx.config();
      client ??= new LinkedInClient({ apiVersion: c.apiVersion, tokens: new TokenManager(c, { fetchImpl }), fetchImpl });
      return client;
    },
  };
  return ctx;
}

export const listPostsInput = {
  count: z.number().int().min(1).max(100).optional().describe("Posts per page (1-100, default 10)."),
  start: z.number().int().min(0).optional().describe("Offset: pass paging.next_start from a previous response."),
  sort_by: z.enum(["LAST_MODIFIED", "CREATED"]).optional().describe("Newest first by last modification (default) or by creation."),
};

export const handlers = {
  async linkedin_get_organization(ctx: ToolContext) {
    return ctx.client().getOrganization(ctx.config().organizationId);
  },
  async linkedin_list_posts(ctx: ToolContext, args: { count?: number; start?: number; sort_by?: "LAST_MODIFIED" | "CREATED" }) {
    return ctx.client().listPosts(organizationUrn(ctx.config().organizationId), { count: args.count, start: args.start, sortBy: args.sort_by });
  },
};

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(sanitize(data), null, 2) }] };
}

export function fail(err: unknown): ToolResult {
  let payload: unknown;
  if (err instanceof LinkedInError) payload = err.name === "ConfigError" ? { error: "ConfigurationError", message: err.message } : err.toJSON();
  else payload = { error: "Error", message: err instanceof Error ? err.message : String(err) };
  return { content: [{ type: "text", text: JSON.stringify(sanitize(payload), null, 2) }], isError: true };
}

export async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "linkedin", version: "0.1.0" });

  server.registerTool(
    "linkedin_get_organization",
    {
      title: "Get LinkedIn Company Page",
      description:
        "Read the configured LinkedIn organization (LINKEDIN_ORGANIZATION_ID): id, URN, name, vanity name, website. " +
        "Needs rw_organization_admin and a page administrator. Read-only.",
      annotations: READ_ONLY,
    },
    () => run(() => handlers.linkedin_get_organization(ctx)),
  );

  server.registerTool(
    "linkedin_list_posts",
    {
      title: "List LinkedIn Company Page posts",
      description:
        "List posts of the configured LinkedIn organization, newest first (one page; use paging.next_start to continue). " +
        "Commentary is in LinkedIn's escaped text format. Read-only: no publishing, editing or deleting.",
      inputSchema: listPostsInput,
      annotations: READ_ONLY,
    },
    (args) => run(() => handlers.linkedin_list_posts(ctx, args)),
  );

  return server;
}
