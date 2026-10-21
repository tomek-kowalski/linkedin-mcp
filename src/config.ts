import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ConfigError } from "./errors.js";
import { registerSecret } from "./sanitize.js";

/** Package root: dist/src/config.js -> ../.. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Organization posting (w_organization_social), reading its posts (r_organization_social)
 * and the organization lookup (rw_organization_admin). All need the Community Management API.
 */
export const DEFAULT_SCOPES = ["r_organization_social", "w_organization_social", "rw_organization_admin"] as const;

export interface LinkedInConfig {
  clientId: string;
  clientSecret: string;
  organizationId: string;
  /** LinkedIn-Version header, YYYYMM */
  apiVersion: string;
  /** Absolute path outside this package */
  tokenFile: string;
  /** Loopback URL the local auth flow listens on; registered in the app exactly like this */
  redirectUri: string;
  scopes: string[];
}

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : typeof v === "string" ? v.trim() : v);
const required = (name: string) => z.preprocess(blankToUndefined, z.string({ error: `${name} is not set` }));

export const apiVersionSchema = z
  .string()
  .regex(/^20\d\d(0[1-9]|1[0-2])$/, "LINKEDIN_API_VERSION must be an exact version in the form YYYYMM, e.g. 202610");

const envSchema = z.object({
  LINKEDIN_CLIENT_ID: required("LINKEDIN_CLIENT_ID").pipe(z.string().regex(/^[A-Za-z0-9]{6,64}$/, "LINKEDIN_CLIENT_ID must be the app's client id (letters and digits)")),
  LINKEDIN_CLIENT_SECRET: required("LINKEDIN_CLIENT_SECRET").pipe(z.string().min(8, "LINKEDIN_CLIENT_SECRET looks too short")),
  LINKEDIN_ORGANIZATION_ID: required("LINKEDIN_ORGANIZATION_ID").pipe(z.string().regex(/^\d{1,20}$/, "LINKEDIN_ORGANIZATION_ID must be the numeric id of the Company Page")),
  LINKEDIN_API_VERSION: required("LINKEDIN_API_VERSION").pipe(apiVersionSchema),
  LINKEDIN_TOKEN_FILE: required("LINKEDIN_TOKEN_FILE").pipe(z.string().refine((p) => isAbsolute(p), "LINKEDIN_TOKEN_FILE must be an absolute path")),
  LINKEDIN_REDIRECT_URI: required("LINKEDIN_REDIRECT_URI"),
  LINKEDIN_SCOPES: z.preprocess(blankToUndefined, z.string().optional()),
});

/**
 * Reads and validates the configuration from the given environment. Nothing is
 * read implicitly: a host application passes its own values (see lib.ts).
 * Error messages name the variables, never their values.
 */
export function readConfig(env: Record<string, string | undefined>, options: { packageRoot?: string } = {}): LinkedInConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.message);
    throw new ConfigError(`LinkedIn configuration is invalid: ${[...new Set(issues)].join("; ")}. See .env.example.`);
  }
  const e = parsed.data;
  registerSecret(e.LINKEDIN_CLIENT_SECRET);

  const tokenFile = resolve(e.LINKEDIN_TOKEN_FILE);
  const root = resolve(options.packageRoot ?? PACKAGE_ROOT);
  const rel = relative(root, tokenFile);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new ConfigError("LINKEDIN_TOKEN_FILE must be outside the linkedin-mcp repository (it is public).");
  }

  const scopes = e.LINKEDIN_SCOPES ? e.LINKEDIN_SCOPES.split(/[\s,]+/).filter(Boolean) : [...DEFAULT_SCOPES];
  if (!scopes.every((s) => /^[a-z_]{3,64}$/.test(s))) throw new ConfigError("LINKEDIN_SCOPES must be space-separated scope names.");

  return {
    clientId: e.LINKEDIN_CLIENT_ID,
    clientSecret: e.LINKEDIN_CLIENT_SECRET,
    organizationId: e.LINKEDIN_ORGANIZATION_ID,
    apiVersion: e.LINKEDIN_API_VERSION,
    tokenFile,
    redirectUri: validateRedirectUri(e.LINKEDIN_REDIRECT_URI),
    scopes,
  };
}

/** The local flow listens on the redirect URI, so it must be plain http on a loopback host with an explicit port. */
export function validateRedirectUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("LINKEDIN_REDIRECT_URI is not a valid URL.");
  }
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || !url.port) {
    throw new ConfigError("LINKEDIN_REDIRECT_URI must be http://localhost:<port>/<path> or http://127.0.0.1:<port>/<path>.");
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new ConfigError("LINKEDIN_REDIRECT_URI must not contain a query, fragment or credentials.");
  }
  return url.toString();
}

export const organizationUrn = (organizationId: string) => `urn:li:organization:${organizationId}`;
