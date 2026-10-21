import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { AuthError, ConfigError } from "./errors.js";
import { registerSecret } from "./sanitize.js";

/**
 * The OAuth tokens, in one JSON file outside the repository (LINKEDIN_TOKEN_FILE).
 * Written atomically (temporary file, then rename) and readable by the owner only
 * where the file system supports it. Values are registered for redaction on read.
 */

const timestamp = z.iso.datetime();

export const storedTokens = z
  .object({
    version: z.literal(1),
    /** the app the tokens belong to: tokens from another app are not used */
    client_id: z.string(),
    access_token: z.string().min(1),
    expires_at: timestamp,
    scopes: z.array(z.string()),
    /** only for apps LinkedIn enabled refresh tokens for (approved partners) */
    refresh_token: z.string().min(1).nullable(),
    refresh_token_expires_at: timestamp.nullable(),
    obtained_at: timestamp,
  })
  .strict();
export type StoredTokens = z.infer<typeof storedTokens>;

export function readTokens(file: string): StoredTokens | null {
  if (!existsSync(file)) return null;
  // POSIX: like ssh, refuse a token file other users can read (Windows: the profile's ACLs apply)
  if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
    throw new ConfigError("The LinkedIn token file is readable by other users: run chmod 600 on it (LINKEDIN_TOKEN_FILE).");
  }
  let parsed: z.ZodSafeParseResult<StoredTokens>;
  try {
    parsed = storedTokens.safeParse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new AuthError("The LinkedIn token file is not valid JSON. Run `npm run auth` in linkedin-mcp to sign in again.", "not_sent");
  }
  if (!parsed.success) {
    throw new AuthError("The LinkedIn token file has an unexpected format. Run `npm run auth` in linkedin-mcp to sign in again.", "not_sent");
  }
  registerSecret(parsed.data.access_token);
  registerSecret(parsed.data.refresh_token);
  return parsed.data;
}

export function writeTokens(file: string, tokens: StoredTokens): void {
  const data = storedTokens.parse(tokens);
  registerSecret(data.access_token);
  registerSecret(data.refresh_token);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameWithRetry(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  try {
    chmodSync(file, 0o600); // no effect on Windows, where the user profile's ACLs apply
  } catch {
    // best effort
  }
}

/**
 * rename() replaces the file in one step, so a reader sees the old or the new tokens, never
 * a partial file. On Windows it fails while another process has the file open
 * (EPERM/EACCES/EBUSY): retried briefly.
 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 40 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10 * (attempt + 1), 100)); // up to ~3.5 s
    }
  }
}

/** What can be said about the tokens without revealing them. */
export interface TokenStatus {
  state: "missing" | "valid" | "expired" | "refreshable";
  expires_at: string | null;
  scopes: string[];
  refresh_token: boolean;
  refresh_token_expires_at: string | null;
}

export function tokenStatus(tokens: StoredTokens | null, now: Date, skewMs: number): TokenStatus {
  if (!tokens) return { state: "missing", expires_at: null, scopes: [], refresh_token: false, refresh_token_expires_at: null };
  const valid = Date.parse(tokens.expires_at) - skewMs > now.getTime();
  return {
    state: valid ? "valid" : refreshUsable(tokens, now, skewMs) ? "refreshable" : "expired",
    expires_at: tokens.expires_at,
    scopes: tokens.scopes,
    refresh_token: tokens.refresh_token !== null,
    refresh_token_expires_at: tokens.refresh_token_expires_at,
  };
}

export function refreshUsable(tokens: StoredTokens, now: Date, skewMs: number): boolean {
  if (!tokens.refresh_token) return false;
  if (!tokens.refresh_token_expires_at) return true;
  return Date.parse(tokens.refresh_token_expires_at) - skewMs > now.getTime();
}
