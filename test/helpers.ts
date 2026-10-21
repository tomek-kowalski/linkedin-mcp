import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinkedInConfig } from "../src/config.js";
import { writeTokens, type StoredTokens } from "../src/token-store.js";

export const FAKE_ACCESS = "AQVfakeAccessTokenForUnitTests0123456789abcdef";
export const FAKE_REFRESH = "AQXfakeRefreshTokenForUnitTests0123456789abcdef";
export const FAKE_SECRET = "fakeClientSecretValue123";
export const NOW = new Date("2026-10-21T12:00:00.000Z");

export interface Call {
  url: string;
  init: RequestInit;
}

export interface Reply {
  status?: number;
  body?: string | object;
  headers?: Record<string, string>;
  /** throw instead of answering (network failure) */
  throws?: Error;
}

export function mockFetch(responder: (url: string, init: RequestInit) => Reply) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const r = responder(url, init ?? {});
    if (r.throws) throw r.throws;
    const body = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : body, { status, headers: { "content-type": "application/json", ...r.headers } });
  }) as typeof fetch;
  return { impl, calls };
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "linkedin-mcp-test-"));
}

export function testConfig(dir = tempDir()): LinkedInConfig {
  return {
    clientId: "77abcdefgh",
    clientSecret: FAKE_SECRET,
    organizationId: "123456",
    apiVersion: "202610",
    tokenFile: join(dir, "linkedin-token.json"),
    redirectUri: "http://localhost:8765/callback",
    scopes: ["r_organization_social", "w_organization_social", "rw_organization_admin"],
  };
}

export function tokens(overrides: Partial<StoredTokens> = {}): StoredTokens {
  return {
    version: 1,
    client_id: "77abcdefgh",
    access_token: FAKE_ACCESS,
    expires_at: "2026-12-20T12:00:00.000Z",
    scopes: ["r_organization_social", "w_organization_social", "rw_organization_admin"],
    refresh_token: null,
    refresh_token_expires_at: null,
    obtained_at: "2026-10-21T12:00:00.000Z",
    ...overrides,
  };
}

export function signedIn(config: LinkedInConfig, overrides: Partial<StoredTokens> = {}): void {
  writeTokens(config.tokenFile, tokens(overrides));
}

export const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

/** A minimal PNG signature followed by a few bytes. */
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
