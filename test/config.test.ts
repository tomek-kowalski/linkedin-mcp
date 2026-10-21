import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { DEFAULT_SCOPES, PACKAGE_ROOT, readConfig, validateRedirectUri } from "../src/config.js";
import { ConfigError } from "../src/errors.js";
import { FAKE_SECRET, tempDir } from "./helpers.js";

const env = (overrides: Record<string, string | undefined> = {}) => ({
  LINKEDIN_CLIENT_ID: "77abcdefgh",
  LINKEDIN_CLIENT_SECRET: FAKE_SECRET,
  LINKEDIN_ORGANIZATION_ID: "123456",
  LINKEDIN_API_VERSION: "202610",
  LINKEDIN_TOKEN_FILE: join(tempDir(), "linkedin-token.json"),
  LINKEDIN_REDIRECT_URI: "http://localhost:8765/callback",
  ...overrides,
});

test("valid configuration with the default scopes", () => {
  const c = readConfig(env());
  assert.equal(c.organizationId, "123456");
  assert.equal(c.apiVersion, "202610");
  assert.deepEqual(c.scopes, [...DEFAULT_SCOPES]);
  assert.equal(c.redirectUri, "http://localhost:8765/callback");
});

test("missing variables are named, values never shown", () => {
  assert.throws(
    () => readConfig(env({ LINKEDIN_CLIENT_ID: "  ", LINKEDIN_ORGANIZATION_ID: undefined, LINKEDIN_CLIENT_SECRET: undefined })),
    (err: unknown) => err instanceof ConfigError && /LINKEDIN_CLIENT_ID is not set/.test(err.message) && /LINKEDIN_ORGANIZATION_ID is not set/.test(err.message) && err.outcome === "not_sent",
  );
  assert.throws(
    () => readConfig(env({ LINKEDIN_API_VERSION: "bad" })),
    (err: unknown) => err instanceof ConfigError && !err.message.includes(FAKE_SECRET),
  );
});

test("the API version must be an exact YYYYMM", () => {
  for (const v of ["2026-10", "202613", "v202610", "2026", "202600"]) {
    assert.throws(() => readConfig(env({ LINKEDIN_API_VERSION: v })), /YYYYMM/, v);
  }
});

test("the token file must be absolute and outside the repository", () => {
  assert.throws(() => readConfig(env({ LINKEDIN_TOKEN_FILE: "token.json" })), /absolute path/);
  assert.throws(() => readConfig(env({ LINKEDIN_TOKEN_FILE: resolve(PACKAGE_ROOT, "secrets", "token.json") })), /outside the linkedin-mcp repository/);
  const root = tempDir();
  assert.throws(() => readConfig(env({ LINKEDIN_TOKEN_FILE: join(root, "token.json") }), { packageRoot: root }), /outside/);
});

test("the redirect URI must be a loopback http URL with a port", () => {
  assert.equal(validateRedirectUri("http://127.0.0.1:9000/cb"), "http://127.0.0.1:9000/cb");
  for (const bad of ["https://localhost:8765/callback", "http://example.com:8765/callback", "http://localhost/callback", "http://localhost:8765/callback?x=1", "nope"]) {
    assert.throws(() => validateRedirectUri(bad), ConfigError, bad);
  }
});

test("custom scopes are split and checked", () => {
  assert.deepEqual(readConfig(env({ LINKEDIN_SCOPES: "r_organization_social, w_organization_social" })).scopes, ["r_organization_social", "w_organization_social"]);
  assert.throws(() => readConfig(env({ LINKEDIN_SCOPES: "bad scope!" })), /LINKEDIN_SCOPES/);
});
