import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { AuthError, NetworkError } from "../src/errors.js";
import { authorize, authorizationUrl, exchangeCode, parseCallback, stateMatches, TOKEN_URL, TokenManager } from "../src/oauth.js";
import { clearSecrets, redactString } from "../src/sanitize.js";
import { readTokens, writeTokens } from "../src/token-store.js";
import { FAKE_ACCESS, FAKE_REFRESH, FAKE_SECRET, mockFetch, NOW, signedIn, tempDir, testConfig, tokens } from "./helpers.js";

beforeEach(() => clearSecrets());

const now = () => NOW;

test("authorization URL carries code flow, client, redirect, state and scopes", () => {
  const url = new URL(authorizationUrl(testConfig(), "STATE123"));
  assert.equal(url.origin + url.pathname, "https://www.linkedin.com/oauth/v2/authorization");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "77abcdefgh");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:8765/callback");
  assert.equal(url.searchParams.get("state"), "STATE123");
  assert.equal(url.searchParams.get("scope"), "r_organization_social w_organization_social rw_organization_admin");
  assert.equal(url.searchParams.get("client_secret"), null);
});

test("callback: state mismatch, wrong path, LinkedIn error and missing code are refused", () => {
  const redirect = "http://localhost:8765/callback";
  assert.deepEqual(parseCallback("/callback?code=abcdefghijkl&state=S1", redirect, "S1"), { code: "abcdefghijkl" });
  assert.throws(() => parseCallback("/callback?code=abc&state=EVIL", redirect, "S1"), /state .* doesn't match/);
  assert.throws(() => parseCallback("/callback?code=abc", redirect, "S1"), /doesn't match/);
  assert.throws(() => parseCallback("/other?code=abc&state=S1", redirect, "S1"), /Unexpected path/);
  assert.throws(
    () => parseCallback("/callback?error=user_cancelled_authorize&error_description=The+user+cancelled&state=S1", redirect, "S1"),
    (err: unknown) => err instanceof AuthError && err.code === "user_cancelled_authorize" && /not granted/.test(err.message),
  );
  assert.throws(() => parseCallback("/callback?state=S1", redirect, "S1"), /no authorization code/);
});

test("code exchange: form post with secret in the body, tokens with expiry; secrets redacted", async () => {
  const config = testConfig();
  const { impl, calls } = mockFetch(() => ({ body: { access_token: FAKE_ACCESS, expires_in: 5184000, scope: "r_organization_social,w_organization_social" } }));
  const t = await exchangeCode(config, "AUTHCODE-0123456789", { fetchImpl: impl, now });
  assert.equal(calls[0].url, TOKEN_URL);
  assert.equal(calls[0].init.method, "POST");
  const form = new URLSearchParams(String(calls[0].init.body));
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "AUTHCODE-0123456789");
  assert.equal(form.get("client_secret"), FAKE_SECRET);
  assert.equal(form.get("redirect_uri"), config.redirectUri);
  assert.equal(t.expires_at, "2026-12-20T12:00:00.000Z");
  assert.deepEqual(t.scopes, ["r_organization_social", "w_organization_social"]);
  assert.equal(t.refresh_token, null);
  // registered for redaction
  assert.equal(redactString(`x ${FAKE_ACCESS} AUTHCODE-0123456789`), "x [REDACTED] [REDACTED]");
});

test("code exchange refused: AuthError without the code or secret in the message", async () => {
  const { impl } = mockFetch(() => ({ status: 400, body: { error: "invalid_request", error_description: "Unable to retrieve access token: appid/redirect uri/code verifier does not match authorization code. code=AUTHCODE-0123456789" } }));
  await assert.rejects(exchangeCode(testConfig(), "AUTHCODE-0123456789", { fetchImpl: impl, now }), (err: unknown) => {
    assert.ok(err instanceof AuthError);
    assert.equal(err.outcome, "rejected");
    assert.ok(!err.message.includes("AUTHCODE-0123456789"));
    assert.ok(!err.message.includes(FAKE_SECRET));
    return true;
  });
});

test("token store: atomic write, round trip, no temporary file left", () => {
  const config = testConfig();
  writeTokens(config.tokenFile, tokens());
  assert.deepEqual(readTokens(config.tokenFile), tokens());
  assert.deepEqual(readdirSync(dirname(config.tokenFile)), ["linkedin-token.json"]);
  if (process.platform !== "win32") assert.equal((statSync(config.tokenFile).mode & 0o777).toString(8), "600");
});

test("token store: a damaged file means signing in again", () => {
  const config = testConfig();
  writeFileSync(config.tokenFile, "{not json");
  assert.throws(() => readTokens(config.tokenFile), (err: unknown) => err instanceof AuthError && err.reauthorize && /npm run auth/.test(err.message));
  writeFileSync(config.tokenFile, JSON.stringify({ access_token: "x" }));
  assert.throws(() => readTokens(config.tokenFile), /unexpected format/);
});

test("valid token: returned without any request", async () => {
  const config = testConfig();
  signedIn(config);
  const { impl, calls } = mockFetch(() => ({ body: {} }));
  const m = new TokenManager(config, { fetchImpl: impl, now });
  assert.equal(await m.getAccessToken(["w_organization_social"]), FAKE_ACCESS);
  assert.equal(calls.length, 0);
  assert.equal(m.status().state, "valid");
});

test("not signed in, or tokens of another app: reauthorize, nothing sent", async () => {
  const config = testConfig();
  const { impl, calls } = mockFetch(() => ({ body: {} }));
  const m = new TokenManager(config, { fetchImpl: impl, now });
  await assert.rejects(m.getAccessToken(), (err: unknown) => err instanceof AuthError && err.outcome === "not_sent" && err.reauthorize);
  signedIn(config, { client_id: "otherapp99" });
  await assert.rejects(m.getAccessToken(), /Not signed in/);
  assert.equal(m.status().state, "missing");
  assert.equal(calls.length, 0);
});

test("expired token without a refresh token: fails before any request", async () => {
  const config = testConfig();
  signedIn(config, { expires_at: "2026-10-21T12:04:00.000Z" }); // within the 5-minute margin
  const { impl, calls } = mockFetch(() => ({ body: {} }));
  const m = new TokenManager(config, { fetchImpl: impl, now });
  await assert.rejects(m.getAccessToken(), (err: unknown) => err instanceof AuthError && err.outcome === "not_sent" && /expired/.test(err.message));
  assert.equal(m.status().state, "expired");
  assert.equal(calls.length, 0);
});

test("ensureValid: a token that expires during the publication window is refused up front", async () => {
  const config = testConfig();
  signedIn(config, { expires_at: "2026-10-21T12:20:00.000Z" });
  const m = new TokenManager(config, { now });
  await m.ensureValid(); // fine right now
  await assert.rejects(m.ensureValid(30 * 60_000), /expired or is about to/);
});

test("missing scope: refused before any request", async () => {
  const config = testConfig();
  signedIn(config, { scopes: ["r_organization_social"] });
  const m = new TokenManager(config, { now });
  await assert.rejects(m.getAccessToken(["w_organization_social"]), (err: unknown) => err instanceof AuthError && /lacks w_organization_social/.test(err.message));
});

test("expired token with a refresh token: refreshed once, stored, old refresh token kept", async () => {
  const config = testConfig();
  signedIn(config, { expires_at: "2026-10-21T11:00:00.000Z", refresh_token: FAKE_REFRESH, refresh_token_expires_at: "2027-10-21T12:00:00.000Z" });
  const fresh = "AQVnewAccessTokenAfterRefresh0123456789";
  const { impl, calls } = mockFetch(() => ({ body: { access_token: fresh, expires_in: 5184000 } }));
  const m = new TokenManager(config, { fetchImpl: impl, now });
  assert.equal(m.status().state, "refreshable");
  const [a, b] = await Promise.all([m.getAccessToken(), m.getAccessToken()]);
  assert.equal(a, fresh);
  assert.equal(b, fresh);
  assert.equal(calls.length, 1);
  const form = new URLSearchParams(String(calls[0].init.body));
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), FAKE_REFRESH);
  const stored = readTokens(config.tokenFile)!;
  assert.equal(stored.access_token, fresh);
  assert.equal(stored.refresh_token, FAKE_REFRESH);
  assert.equal(stored.refresh_token_expires_at, "2027-10-21T12:00:00.000Z");
});

test("refresh refused or refresh token expired: reauthorize", async () => {
  const config = testConfig();
  signedIn(config, { expires_at: "2026-10-21T11:00:00.000Z", refresh_token: FAKE_REFRESH, refresh_token_expires_at: "2027-10-21T12:00:00.000Z" });
  const { impl } = mockFetch(() => ({ status: 400, body: { error: "invalid_request", error_description: "The provided authorization grant or refresh token is invalid, expired or revoked" } }));
  await assert.rejects(
    new TokenManager(config, { fetchImpl: impl, now }).getAccessToken(),
    (err: unknown) => err instanceof AuthError && err.reauthorize && err.outcome === "not_sent" && !err.message.includes(FAKE_REFRESH),
  );

  signedIn(config, { expires_at: "2026-10-21T11:00:00.000Z", refresh_token: FAKE_REFRESH, refresh_token_expires_at: "2026-10-01T00:00:00.000Z" });
  await assert.rejects(new TokenManager(config, { fetchImpl: impl, now }).getAccessToken(), /expired/);
});

test("token endpoint unreachable: NetworkError", async () => {
  const { impl } = mockFetch(() => ({ throws: new TypeError("fetch failed") }));
  await assert.rejects(exchangeCode(testConfig(), "AUTHCODE-0123456789", { fetchImpl: impl, now }), NetworkError);
});

async function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolvePort(port));
    });
  });
}

test("local flow end to end: redirect with the right state is exchanged and stored", async () => {
  const port = await freePort();
  const config = { ...testConfig(), redirectUri: `http://127.0.0.1:${port}/callback` };
  const tokenFetch = mockFetch(() => ({ body: { access_token: FAKE_ACCESS, expires_in: 5184000, scope: config.scopes.join(",") } }));
  let shown = "";
  const done = authorize(config, {
    fetchImpl: tokenFetch.impl,
    now,
    state: "FIXEDSTATE0123456789",
    onAuthorizationUrl: (url) => {
      shown = url;
      // a stray request elsewhere is ignored, then LinkedIn's redirect arrives
      void fetch(`http://127.0.0.1:${port}/favicon.ico`)
        .then(() => fetch(`http://127.0.0.1:${port}/callback?code=AUTHCODE-0123456789&state=FIXEDSTATE0123456789`))
        .then((r) => r.text());
    },
  });
  const status = await done;
  assert.match(shown, /state=FIXEDSTATE0123456789/);
  assert.equal(status.state, "valid");
  assert.equal(readTokens(config.tokenFile)!.access_token, FAKE_ACCESS);
  assert.ok(!readFileSync(config.tokenFile, "utf8").includes("AUTHCODE"));
});

/** A raw HTTP/1.1 GET, so the request target and Host header are exactly what a test sends. */
async function rawGet(port: number, target: string, host = `127.0.0.1:${port}`): Promise<number> {
  const { connect } = await import("node:net");
  return new Promise((resolveStatus, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    let data = "";
    socket.on("data", (d) => (data += d));
    socket.on("end", () => resolveStatus(Number(data.split(" ")[1])));
    socket.on("error", reject);
  });
}

test("local flow: forged state, wrong Host and odd targets are ignored; the genuine redirect still signs in", async () => {
  const port = await freePort();
  const config = { ...testConfig(), redirectUri: `http://127.0.0.1:${port}/callback` };
  const tokenFetch = mockFetch(() => ({ body: { access_token: FAKE_ACCESS, expires_in: 5184000 } }));
  const ignored: string[] = [];
  const statuses: number[] = [];
  let requests: Promise<void> = Promise.resolve();
  const done = authorize(config, {
    fetchImpl: tokenFetch.impl,
    now,
    state: "FIXEDSTATE0123456789",
    onIgnored: (reason) => ignored.push(reason),
    onAuthorizationUrl: () =>
      void (requests = (async () => {
        statuses.push(await rawGet(port, "/callback?code=ATTACKERCODE-0123456789&state=FORGED"));
        statuses.push(await rawGet(port, "/callback?code=ATTACKERCODE-0123456789"));
        statuses.push(await rawGet(port, "/callback?code=ATTACKERCODE-0123456789&state=FIXEDSTATE0123456789", "evil.example"));
        statuses.push(await rawGet(port, "//evil.example/callback?code=ATTACKERCODE-0123456789&state=FIXEDSTATE0123456789"));
        statuses.push(await rawGet(port, "/callback?code=AUTHCODE-0123456789&state=FIXEDSTATE0123456789"));
      })()),
  });
  const status = await done;
  await requests;
  assert.equal(status.state, "valid");
  assert.deepEqual(statuses, [400, 400, 400, 404, 200]);
  assert.equal(ignored.length, 3);
  // only the genuine code was exchanged
  assert.equal(tokenFetch.calls.length, 1);
  assert.equal(new URLSearchParams(String(tokenFetch.calls[0].init.body)).get("code"), "AUTHCODE-0123456789");
});

test("local flow: only forged redirects → times out, nothing exchanged or stored", async () => {
  const port = await freePort();
  const config = { ...testConfig(), redirectUri: `http://127.0.0.1:${port}/callback` };
  const tokenFetch = mockFetch(() => ({ body: {} }));
  const done = authorize(config, {
    fetchImpl: tokenFetch.impl,
    state: "FIXEDSTATE0123456789",
    waitMs: 300,
    onAuthorizationUrl: () => void rawGet(port, "/callback?code=AUTHCODE-0123456789&state=FORGED"),
  });
  await assert.rejects(done, (e: unknown) => e instanceof AuthError && /in time/.test((e as Error).message));
  assert.equal(tokenFetch.calls.length, 0);
  assert.equal(existsSync(join(dirname(config.tokenFile), "linkedin-token.json")), false);
});

test("local flow: the owner cancelling (right state, error) ends the flow with the reason", async () => {
  const port = await freePort();
  const config = { ...testConfig(), redirectUri: `http://127.0.0.1:${port}/callback` };
  const done = authorize(config, {
    state: "FIXEDSTATE0123456789",
    onAuthorizationUrl: () => void rawGet(port, "/callback?error=user_cancelled_authorize&error_description=cancelled&state=FIXEDSTATE0123456789"),
  });
  await assert.rejects(done, (e: unknown) => e instanceof AuthError && e.code === "user_cancelled_authorize");
});

test("callback parsing: absolute and protocol-relative targets are refused", () => {
  const redirect = "http://localhost:8765/callback";
  assert.throws(() => parseCallback("//evil.example/callback?code=abc&state=S1", redirect, "S1"), /Unexpected/);
  assert.throws(() => parseCallback("http://evil.example/callback?code=abc&state=S1", redirect, "S1"), /Unexpected/);
  assert.equal(stateMatches("/callback?state=S1", redirect, ""), false);
});

test("token store: concurrent writers in other threads never leave a partial file for readers", async () => {
  const config = testConfig();
  writeTokens(config.tokenFile, tokens());
  const { Worker } = await import("node:worker_threads");
  const storeUrl = new URL("../src/token-store.js", import.meta.url).href;
  const code = `
    const { workerData } = require("node:worker_threads");
    import(workerData.storeUrl).then(({ writeTokens }) => {
      for (let i = 0; i < 40; i++) writeTokens(workerData.file, { ...workerData.tokens, access_token: "AQVworker" + workerData.n + "-" + i + "-0123456789abcdef" });
    });`;
  const workers = [1, 2, 3].map((n) => new Worker(code, { eval: true, workerData: { storeUrl, file: config.tokenFile, tokens: tokens(), n } }));
  const finished = Promise.all(workers.map((w) => new Promise((done, fail) => (w.on("exit", done), w.on("error", fail)))));
  let reads = 0;
  let running = true;
  void finished.then(() => (running = false));
  while (running) {
    const t = readTokens(config.tokenFile); // throws on a partial or invalid file
    assert.ok(t && t.access_token.startsWith("AQV"));
    reads += 1;
    await new Promise((r) => setImmediate(r));
  }
  await finished;
  assert.ok(reads > 0);
  assert.match(readTokens(config.tokenFile)!.access_token, /^AQVworker\d-39-/);
  assert.deepEqual(readdirSync(dirname(config.tokenFile)), ["linkedin-token.json"]);
});

test("token store: a token file readable by others is refused (POSIX)", { skip: process.platform === "win32" }, async () => {
  const { chmodSync } = await import("node:fs");
  const config = testConfig();
  writeTokens(config.tokenFile, tokens());
  chmodSync(config.tokenFile, 0o644);
  assert.throws(() => readTokens(config.tokenFile), /readable by other users/);
});
