#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadDotEnv } from "./env.js";
import { logError } from "./sanitize.js";
import { createContext, createServer } from "./server.js";

async function main(): Promise<void> {
  loadDotEnv();
  const ctx = createContext(process.env);
  try {
    ctx.config();
  } catch (err) {
    logError(`${err instanceof Error ? err.message : String(err)} Tools will return configuration errors.`);
  }
  await createServer(ctx).connect(new StdioServerTransport());
}

main().catch((err) => {
  logError(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
