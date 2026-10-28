#!/usr/bin/env node
import { readConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { authorize, EXPIRY_SKEW_MS, TokenManager } from "./oauth.js";
import { redactString } from "./sanitize.js";

/**
 * npm run auth            sign in (opens a loopback listener on LINKEDIN_REDIRECT_URI)
 * npm run auth -- --status  show the stored token's state (never the token)
 *
 * Run it in your own terminal: you open the printed URL and approve in the browser.
 */

const out = (line: string) => process.stdout.write(`${redactString(line)}\n`);

async function main(): Promise<number> {
  loadDotEnv();
  const config = readConfig(process.env);
  const tokens = new TokenManager(config);

  if (process.argv.includes("--status")) {
    const s = tokens.status();
    out(`Token: ${s.state}${s.expires_at ? `, expires ${s.expires_at}` : ""}`);
    out(`Scopes: ${s.scopes.join(" ") || "(none)"}`);
    out(`Refresh token: ${s.refresh_token ? `yes${s.refresh_token_expires_at ? `, until ${s.refresh_token_expires_at}` : ""}` : "no (sign in again before expiry)"}`);
    return s.state === "valid" || s.state === "refreshable" ? 0 : 1;
  }

  out(`Signing in to LinkedIn with scopes: ${config.scopes.join(" ")}`);
  out(`Waiting on ${config.redirectUri} (5 minutes). Open this URL in your browser and approve:\n`);
  // printed as is: redaction would replace the state, and LinkedIn would send that placeholder back.
  // The URL holds no secret (client id, redirect URI, scopes, the one-time state).
  const status = await authorize(config, { onAuthorizationUrl: (url) => process.stdout.write(`  ${url}\n\n`) });
  out(`Signed in. Token valid until ${status.expires_at} (treated as expired ${EXPIRY_SKEW_MS / 60_000} minutes early).`);
  out(`Granted scopes: ${status.scopes.join(" ") || "(none reported)"}`);
  const missing = config.scopes.filter((s) => !status.scopes.includes(s));
  if (missing.length) out(`Not granted: ${missing.join(" ")}. Calls that need them will fail until the app is approved for them.`);
  out(`Refresh token: ${status.refresh_token ? "yes" : "no: run npm run auth again before the token expires"}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[linkedin-mcp] ${redactString(err instanceof Error ? err.message : String(err))}\n`);
    process.exit(1);
  },
);
