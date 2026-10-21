/**
 * The library entry point (`import … from "linkedin-mcp"`). Importing it reads no .env
 * and no environment: the host passes its configuration explicitly.
 */
import { LinkedInClient } from "./client.js";
import { type LinkedInConfig } from "./config.js";
import { TokenManager, type OAuthDeps } from "./oauth.js";

export { LinkedInClient, MAX_IMAGE_BYTES, SCOPES, UPLOAD_HOSTS, postPayload, type ArticlePostInput, type ImagePostInput, type ImageUpload, type Organization, type PostList, type PostPayload, type PostSummary } from "./client.js";
export { DEFAULT_SCOPES, organizationUrn, readConfig, validateRedirectUri, type LinkedInConfig } from "./config.js";
export { ApiRefusalError, AuthError, ConfigError, InvalidResponseError, LinkedInError, NetworkError, RateLimitError, ServerError, type Outcome } from "./errors.js";
export { MAX_COMMENTARY, escapeLittleText, formatCommentary, normalizeText, plainText, textLength } from "./format.js";
export { EXPIRY_SKEW_MS, TokenManager, type OAuthDeps, type TokenProvider } from "./oauth.js";
export { type ErrorDetails } from "./errors.js";
export { redactString, sanitize } from "./sanitize.js";
export { type TokenStatus } from "./token-store.js";

/** A ready client and its token manager for one configuration. */
export function createLinkedIn(config: LinkedInConfig, deps: OAuthDeps & { timeoutMs?: number; uploadTimeoutMs?: number } = {}): { client: LinkedInClient; tokens: TokenManager } {
  const tokens = new TokenManager(config, deps);
  return { tokens, client: new LinkedInClient({ apiVersion: config.apiVersion, tokens, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs, uploadTimeoutMs: deps.uploadTimeoutMs }) };
}
