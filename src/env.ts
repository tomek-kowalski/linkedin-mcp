import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { PACKAGE_ROOT } from "./config.js";

/**
 * Loads <package root>/.env into process.env without overriding values that are
 * already set. Used only by the bin scripts (MCP server, auth); the library never
 * imports this file. Never logs contents; a missing file is not an error.
 */
export function loadDotEnv(file = resolve(PACKAGE_ROOT, ".env")): void {
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined && value !== undefined) process.env[key] = value;
  }
}
