import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import type { LinkedInConfig } from "./config.js";
import { AuthError, InvalidResponseError, LinkedInError, NetworkError } from "./errors.js";
import { registerSecret } from "./sanitize.js";
import { readTokens, refreshUsable, tokenStatus, writeTokens, type StoredTokens, type TokenStatus } from "./token-store.js";

/**
 * OAuth 2.0 authorization code flow (3-legged) for the owner's LinkedIn account:
 *
 * - `npm run auth` opens a one-off loopback listener on LINKEDIN_REDIRECT_URI, prints the
 *   authorization URL, checks the returned `state` (CSRF) and exchanges the code;
 * - access tokens live 60 days; refresh tokens exist only for apps LinkedIn enabled them for,
 *   so refreshing is used when the stored token has one and never assumed;
 * - when no valid token is left, every call fails *before* a request is sent (AuthError,
 *   outcome "not_sent", reauthorize): a publication is never attempted with a dead token.
 */

export const AUTHORIZATION_URL = "https://www.linkedin.com/oauth/v2/authorization";
export const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
/** A token is treated as expired this long before LinkedIn's expiry. */
export const EXPIRY_SKEW_MS = 5 * 60_000;

type OAuthConfig = Pick<LinkedInConfig, "clientId" | "clientSecret" | "redirectUri" | "scopes" | "tokenFile">;

export interface OAuthDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

export function newState(): string {
  return randomBytes(32).toString("base64url");
}

export function authorizationUrl(config: Pick<LinkedInConfig, "clientId" | "redirectUri" | "scopes">, state: string): string {
  const url = new URL(AUTHORIZATION_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", config.scopes.join(" "));
  return url.toString();
}

const tokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().int().positive().optional(),
});

/** POST to the token endpoint (code exchange or refresh) and turn the answer into stored tokens. */
async function tokenRequest(config: OAuthConfig, form: Record<string, string>, deps: OAuthDeps, previous?: StoredTokens): Promise<StoredTokens> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = (deps.now ?? (() => new Date()))();
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ ...form, client_id: config.clientId, client_secret: config.clientSecret }).toString(),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
    });
  } catch (err) {
    throw new NetworkError(`Network error calling the LinkedIn token endpoint: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new InvalidResponseError(`The LinkedIn token endpoint returned invalid JSON (HTTP ${res.status}).`, { status: res.status });
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: unknown; error_description?: unknown };
    const reason = [b.error, b.error_description].filter((v) => typeof v === "string").join(": ") || `HTTP ${res.status}`;
    throw new AuthError(`LinkedIn refused the token request (${reason}). Run \`npm run auth\` in linkedin-mcp to sign in again.`, "rejected", {
      status: res.status,
      code: typeof b.error === "string" ? b.error : undefined,
    });
  }
  const parsed = tokenResponse.safeParse(body);
  if (!parsed.success) throw new InvalidResponseError("The LinkedIn token endpoint answered without an access token.", { status: res.status });
  const t = parsed.data;
  registerSecret(t.access_token);
  registerSecret(t.refresh_token);
  const at = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();
  return {
    version: 1,
    client_id: config.clientId,
    access_token: t.access_token,
    expires_at: at(t.expires_in),
    scopes: t.scope ? t.scope.split(/[\s,]+/).filter(Boolean) : (previous?.scopes ?? config.scopes),
    // a refresh doesn't extend the refresh token: keep the old one when no new one is sent
    refresh_token: t.refresh_token ?? previous?.refresh_token ?? null,
    refresh_token_expires_at: t.refresh_token_expires_in ? at(t.refresh_token_expires_in) : (previous?.refresh_token_expires_at ?? null),
    obtained_at: now.toISOString(),
  };
}

export function exchangeCode(config: OAuthConfig, code: string, deps: OAuthDeps = {}): Promise<StoredTokens> {
  registerSecret(code);
  return tokenRequest(config, { grant_type: "authorization_code", code, redirect_uri: config.redirectUri }, deps);
}

export function refreshTokens(config: OAuthConfig, tokens: StoredTokens, deps: OAuthDeps = {}): Promise<StoredTokens> {
  if (!tokens.refresh_token) throw new AuthError("No refresh token: run `npm run auth` in linkedin-mcp.", "not_sent");
  return tokenRequest(config, { grant_type: "refresh_token", refresh_token: tokens.refresh_token }, deps, tokens);
}

/** Gives the client a valid access token, refreshing when possible; never sends a request with a dead one. */
export interface TokenProvider {
  getAccessToken(requiredScopes?: readonly string[]): Promise<string>;
}

export class TokenManager implements TokenProvider {
  private readonly config: OAuthConfig;
  private readonly deps: OAuthDeps;
  private refreshing: Promise<StoredTokens> | null = null;

  constructor(config: OAuthConfig, deps: OAuthDeps = {}) {
    this.config = config;
    this.deps = deps;
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  status(): TokenStatus {
    return tokenStatus(this.load(), this.now(), EXPIRY_SKEW_MS);
  }

  private load(): StoredTokens | null {
    const tokens = readTokens(this.config.tokenFile);
    return tokens && tokens.client_id === this.config.clientId ? tokens : null;
  }

  async getAccessToken(requiredScopes: readonly string[] = []): Promise<string> {
    return (await this.ensureValid(0, requiredScopes)).access_token;
  }

  /**
   * Makes sure a token is valid for at least `minValidityMs` more (and has the scopes),
   * refreshing if that's possible. A publisher calls this before it starts.
   */
  async ensureValid(minValidityMs = 0, requiredScopes: readonly string[] = []): Promise<StoredTokens> {
    let tokens = this.load();
    if (!tokens) throw new AuthError("Not signed in to LinkedIn: run `npm run auth` in linkedin-mcp.", "not_sent");
    const now = this.now();
    if (Date.parse(tokens.expires_at) - EXPIRY_SKEW_MS - minValidityMs <= now.getTime()) {
      if (!refreshUsable(tokens, now, EXPIRY_SKEW_MS)) {
        throw new AuthError(`The LinkedIn access token expired or is about to (${tokens.expires_at}): run \`npm run auth\` in linkedin-mcp.`, "not_sent");
      }
      tokens = await this.refresh(tokens);
    }
    const missing = requiredScopes.filter((s) => !tokens.scopes.includes(s));
    if (missing.length) {
      throw new AuthError(
        `The LinkedIn token lacks ${missing.join(", ")} (granted: ${tokens.scopes.join(", ") || "none"}). ` +
          "The app needs the product that grants it, the scope in LINKEDIN_SCOPES, then `npm run auth` again.",
        "not_sent",
      );
    }
    return tokens;
  }

  private refresh(tokens: StoredTokens): Promise<StoredTokens> {
    // one refresh at a time: concurrent callers share it. Whatever happens to the refresh,
    // no API request was made yet: the failure is "not_sent" for the caller's write.
    this.refreshing ??= refreshTokens(this.config, tokens, this.deps)
      .then((fresh) => {
        writeTokens(this.config.tokenFile, fresh);
        return fresh;
      })
      .catch((err: unknown) => {
        if (err instanceof LinkedInError && err.outcome === "not_sent") throw err;
        const refused = err instanceof AuthError;
        throw new AuthError(
          `Refreshing the LinkedIn token failed (${err instanceof Error ? err.message : String(err)}). Nothing was sent to LinkedIn.` +
            (refused ? " Run `npm run auth` in linkedin-mcp." : " Try again later."),
          "not_sent",
          { status: err instanceof LinkedInError ? err.status : undefined, reauthorize: refused },
        );
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }
}

/** Parses a request target on the redirect URI: origin-form only ("/path?query"), never "//host/…" or absolute. */
function callbackUrl(requestUrl: string, redirectUri: string): URL {
  const expected = new URL(redirectUri);
  if (!requestUrl.startsWith("/") || requestUrl.startsWith("//")) throw new AuthError("Unexpected request target on the redirect URI.", "not_sent");
  const got = new URL(requestUrl, `${expected.protocol}//${expected.host}`);
  if (got.host !== expected.host || got.pathname !== expected.pathname) throw new AuthError("Unexpected path on the redirect URI.", "not_sent");
  return got;
}

/** Constant-time comparison of the returned state with the one this flow generated. */
export function stateMatches(requestUrl: string, redirectUri: string, expectedState: string): boolean {
  let got: URL;
  try {
    got = callbackUrl(requestUrl, redirectUri);
  } catch {
    return false;
  }
  const a = Buffer.from(got.searchParams.get("state") ?? "");
  const b = Buffer.from(expectedState);
  return expectedState.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

/** What the redirect brought back. Pure: checks the target, the state and LinkedIn's error. */
export function parseCallback(requestUrl: string, redirectUri: string, expectedState: string): { code: string } {
  const got = callbackUrl(requestUrl, redirectUri);
  if (!stateMatches(requestUrl, redirectUri, expectedState)) {
    throw new AuthError("The state returned by LinkedIn doesn't match (possible CSRF): nothing was exchanged. Run `npm run auth` again.", "not_sent");
  }
  const error = got.searchParams.get("error");
  if (error) {
    const description = got.searchParams.get("error_description");
    throw new AuthError(`LinkedIn authorization was not granted (${error}${description ? `: ${description}` : ""}).`, "rejected", { code: error });
  }
  const code = got.searchParams.get("code");
  if (!code) throw new AuthError("The redirect carried no authorization code.", "not_sent");
  registerSecret(code);
  return { code };
}

export interface AuthorizeOptions extends OAuthDeps {
  /** Called with the URL the owner opens in a browser */
  onAuthorizationUrl: (url: string) => void;
  /** How long to wait for the redirect (default 5 minutes) */
  waitMs?: number;
  /** For tests: a fixed state */
  state?: string;
  /** Told about requests that were ignored (wrong state, host or target) */
  onIgnored?: (reason: string) => void;
}

const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;margin:3rem"><h1>${title}</h1><p>${text}</p></body>`;

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

/**
 * Runs the local authorization: listens on the redirect URI (loopback only), waits for
 * LinkedIn's redirect, validates it, exchanges the code and stores the tokens.
 *
 * - A request with the wrong state, Host or target is answered 400 and ignored: it can't
 *   inject a code (CSRF) nor end the flow; the genuine redirect still works.
 * - A redirect with the right state settles the flow: its code is exchanged, or its
 *   `error` (e.g. the owner cancelled) is reported. The listener closes afterwards.
 */
export async function authorize(config: OAuthConfig, options: AuthorizeOptions): Promise<TokenStatus> {
  const redirect = new URL(config.redirectUri);
  const state = options.state ?? newState();
  let server: Server | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const code = await new Promise<string>((resolveCode, reject) => {
      server = createServer((req, res) => {
        const target = req.url ?? "";
        if (req.method !== "GET" || req.headers.host !== redirect.host) {
          res.writeHead(400, PAGE_HEADERS).end(page("Bad request", ""));
          options.onIgnored?.("a request with an unexpected method or Host header");
          return;
        }
        if (!stateMatches(target, config.redirectUri, state)) {
          const onPath = target.startsWith("/") && !target.startsWith("//") && new URL(target, redirect).pathname === redirect.pathname;
          res.writeHead(onPath ? 400 : 404, PAGE_HEADERS).end(page(onPath ? "Authorization failed" : "Not found", ""));
          if (onPath) options.onIgnored?.("a redirect whose state doesn't match (possible CSRF)");
          return;
        }
        try {
          const { code } = parseCallback(target, config.redirectUri, state);
          res.writeHead(200, PAGE_HEADERS).end(page("Signed in", "LinkedIn authorization received. You can close this tab."));
          resolveCode(code);
        } catch (err) {
          res.writeHead(400, PAGE_HEADERS).end(page("Authorization failed", "Return to the terminal for details."));
          reject(err);
        }
      });
      server.on("error", (err) => reject(new AuthError(`Can't listen on ${redirect.host}: ${err.message}`, "not_sent")));
      server.listen(Number(redirect.port), redirect.hostname, () => options.onAuthorizationUrl(authorizationUrl(config, state)));
      timer = setTimeout(() => reject(new AuthError("No redirect from LinkedIn in time: run `npm run auth` again.", "not_sent")), options.waitMs ?? 5 * 60_000);
    });
    const tokens = await exchangeCode(config, code, options);
    writeTokens(config.tokenFile, tokens);
    return tokenStatus(tokens, (options.now ?? (() => new Date()))(), EXPIRY_SKEW_MS);
  } catch (err) {
    if (err instanceof LinkedInError) throw err;
    throw new AuthError(err instanceof Error ? err.message : String(err), "not_sent");
  } finally {
    if (timer) clearTimeout(timer);
    const s = server as Server | undefined;
    if (s) {
      // let the answer to the browser finish; drop idle keep-alive connections, then any left after 2 s
      const closed = new Promise<void>((done) => s.close(() => done()));
      s.closeIdleConnections();
      const force = setTimeout(() => s.closeAllConnections(), 2_000);
      await closed;
      clearTimeout(force);
    }
  }
}
