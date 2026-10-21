import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { API_BASE, LinkedInClient, MAX_IMAGE_BYTES, type ImageUpload, type PostPayload } from "../src/client.js";
import { ApiRefusalError, AuthError, ConfigError, InvalidResponseError, LinkedInError, NetworkError, RateLimitError, ServerError } from "../src/errors.js";
import { TokenManager } from "../src/oauth.js";
import { clearSecrets } from "../src/sanitize.js";
import { FAKE_ACCESS, FAKE_REFRESH, header, mockFetch, NOW, PNG, signedIn, testConfig, type Reply } from "./helpers.js";

beforeEach(() => clearSecrets());

const ORG = "urn:li:organization:123456";
const UPLOAD_URL = "https://www.linkedin.com/dms-uploads/C4E10AQFoyyAjHPMQuQ/uploaded-image/0?ca=vector_ads&cn=uploads&sync=0&v=beta&ut=08zHQjMjAOLqc1";

function setup(responder: (url: string, init: RequestInit) => Reply, tokenOverrides = {}, options: { timeoutMs?: number; uploadTimeoutMs?: number; fetchImpl?: typeof fetch } = {}) {
  const config = testConfig();
  signedIn(config, tokenOverrides);
  const { impl, calls } = mockFetch(responder);
  const client = new LinkedInClient({ apiVersion: config.apiVersion, tokens: new TokenManager(config, { now: () => NOW, fetchImpl: impl }), fetchImpl: options.fetchImpl ?? impl, ...options });
  return { client, calls, config };
}

const textPost = (overrides: Partial<PostPayload> = {}): PostPayload => ({
  author: ORG,
  commentary: "Hello",
  visibility: "PUBLIC",
  distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
  lifecycleState: "PUBLISHED",
  isReshareDisabledByAuthor: false,
  ...overrides,
});

const upload = (overrides: Partial<ImageUpload> = {}): ImageUpload => ({ uploadUrl: UPLOAD_URL, image: "urn:li:image:C4E10AQF", uploadUrlExpiresAt: NOW.getTime() + 3600_000, ...overrides });

const outcomeIs = (cls: new (...a: never[]) => LinkedInError, outcome: string) => (e: unknown) => e instanceof cls && e.outcome === outcome;

// --- configuration and API contract -------------------------------------------------------------

test("the API version must be exact", () => {
  assert.throws(() => new LinkedInClient({ apiVersion: "2026-10", tokens: new TokenManager(testConfig()) }), ConfigError);
});

test("getOrganization: versioned REST headers, rw_organization_admin, a summary", async () => {
  const { client, calls } = setup(() => ({
    body: { id: 123456, localizedName: "ForeachURL", vanityName: "foreachurl", localizedWebsite: "https://foreachurl.app", $URN: ORG },
  }));
  assert.deepEqual(await client.getOrganization("123456"), { id: "123456", urn: ORG, name: "ForeachURL", vanity_name: "foreachurl", website: "https://foreachurl.app" });
  const { url, init } = calls[0];
  assert.equal(url, `${API_BASE}/organizations/123456`);
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "manual");
  assert.equal(header(init, "Authorization"), `Bearer ${FAKE_ACCESS}`);
  assert.equal(header(init, "LinkedIn-Version"), "202610");
  assert.equal(header(init, "X-Restli-Protocol-Version"), "2.0.0");
  await assert.rejects(client.getOrganization("../me"), ConfigError);
});

test("getOrganization without rw_organization_admin: not sent, publishing scopes unaffected", async () => {
  const { client, calls } = setup(() => ({ body: {} }), { scopes: ["r_organization_social", "w_organization_social"] });
  await assert.rejects(client.getOrganization("123456"), (e: unknown) => e instanceof AuthError && e.outcome === "not_sent" && /rw_organization_admin/.test(e.message) && /LINKEDIN_SCOPES/.test(e.message));
  assert.equal(calls.length, 0);
});

// --- listing and pagination ---------------------------------------------------------------------

test("listPosts: finder by author, URL-encoded URN, mapped posts", async () => {
  const { client, calls } = setup(() => ({
    body: {
      paging: { start: 0, count: 10, links: [] },
      elements: [
        {
          id: "urn:li:share:7000000000000000001",
          author: ORG,
          commentary: "Nowy artykuł {hashtag|\\#|WooCommerce}",
          lifecycleState: "PUBLISHED",
          visibility: "PUBLIC",
          createdAt: 1792000000000,
          publishedAt: 1792000000000,
          lastModifiedAt: 1792000001000,
          content: { article: { source: "https://foreachurl.app/en/news/x", title: "X" } },
        },
        { id: "urn:li:ugcPost:7000000000000000002", author: ORG, commentary: "Image", content: { media: { id: "urn:li:image:C4E10AQF" } }, createdAt: "bad" },
      ],
    },
  }));
  const list = await client.listPosts(ORG);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, `${API_BASE}/posts`);
  assert.equal(url.searchParams.get("q"), "author");
  assert.equal(url.searchParams.get("author"), ORG);
  assert.match(calls[0].url, /author=urn%3Ali%3Aorganization%3A123456&/);
  assert.equal(url.searchParams.get("count"), "10");
  assert.equal(url.searchParams.get("start"), "0");
  assert.equal(url.searchParams.get("sortBy"), "LAST_MODIFIED");
  assert.equal(header(calls[0].init, "X-RestLi-Method"), "FINDER");
  assert.equal(list.posts[0].article_source, "https://foreachurl.app/en/news/x");
  assert.equal(list.posts[0].created_at, new Date(1792000000000).toISOString());
  assert.equal(list.posts[1].media_id, "urn:li:image:C4E10AQF");
  assert.equal(list.posts[1].created_at, null);
  assert.equal(list.paging.next_start, null); // 2 of 10: last page
});

test("listPosts pagination: links rel=next, total, full page, empty page", async () => {
  const el = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `urn:li:share:${i + 1}`, author: ORG, commentary: "x" }));
  const cases: [object, { start?: number; count?: number }, number | null][] = [
    [{ paging: { start: 0, count: 2, links: [{ rel: "next", href: "/rest/posts?start=2" }] }, elements: el(1) }, { count: 2 }, 1],
    [{ paging: { start: 4, count: 2, total: 6 }, elements: el(2) }, { start: 4, count: 2 }, null],
    [{ paging: { start: 2, count: 2, total: 9 }, elements: el(2) }, { start: 2, count: 2 }, 4],
    [{ paging: { start: 0, count: 2, links: [] }, elements: el(2) }, { count: 2 }, 2], // full page, no total: maybe more
    [{ paging: { start: 0, count: 2 }, elements: [] }, { count: 2 }, null],
  ];
  for (const [body, options, next] of cases) {
    const { client } = setup(() => ({ body }));
    assert.equal((await client.listPosts(ORG, options)).paging.next_start, next, JSON.stringify(body));
  }
});

test("listPosts: bad input and missing read scope are refused without a request", async () => {
  const { client, calls } = setup(() => ({ body: { elements: [] } }), { scopes: ["w_organization_social"] });
  await assert.rejects(client.listPosts(ORG), outcomeIs(AuthError, "not_sent"));
  await assert.rejects(client.listPosts("urn:li:organization:1&q=x"), ConfigError);
  await assert.rejects(client.listPosts(ORG, { count: 101 }), outcomeIs(ConfigError, "not_sent"));
  await assert.rejects(client.listPosts(ORG, { start: -1 }), ConfigError);
  await assert.rejects(client.listPosts(ORG, { sortBy: "X" as "CREATED" }), ConfigError);
  assert.equal(calls.length, 0);
});

test("listPosts returns post text exactly as LinkedIn sent it (no redaction of look-alikes)", async () => {
  const commentary = "Use ?code=abc&state=xyz and Bearer tokens\\_rotate";
  const { client } = setup(() => ({ body: { elements: [{ id: "urn:li:share:1", author: ORG, commentary }] } }));
  assert.equal((await client.listPosts(ORG)).posts[0].commentary, commentary);
});

// --- posts ----------------------------------------------------------------------------------------

test("createPost: 201, id from x-restli-id, request id from x-li-uuid", async () => {
  const { client, calls } = setup(() => ({ status: 201, headers: { "x-restli-id": "urn:li:share:7000000000000000003", "x-li-uuid": "slguD4sMzhUwATrTkisAAA==" } }));
  assert.deepEqual(await client.createPost(textPost()), { id: "urn:li:share:7000000000000000003", requestId: "slguD4sMzhUwATrTkisAAA==" });
  assert.equal(calls[0].url, `${API_BASE}/posts`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(header(calls[0].init, "Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), textPost());
});

test("createPost: a URL-encoded x-restli-id is accepted; a missing or foreign one is an unknown outcome", async () => {
  const encoded = setup(() => ({ status: 201, headers: { "x-restli-id": "urn%3Ali%3AugcPost%3A7000000000000000009" } }));
  assert.equal((await encoded.client.createPost(textPost())).id, "urn:li:ugcPost:7000000000000000009");
  const variants: Record<string, string>[] = [{}, { "x-restli-id": "" }, { "x-restli-id": "urn:li:image:X" }, { "x-restli-id": "%E0%A4%A" }];
  for (const headers of variants) {
    const { client } = setup(() => ({ status: 201, headers: { ...headers, "x-li-uuid": "req-1" } }));
    await assert.rejects(client.createPost(textPost()), (e: unknown) => {
      assert.ok(e instanceof InvalidResponseError, JSON.stringify(headers));
      assert.equal(e.outcome, "unknown");
      assert.equal(e.status, 201);
      assert.equal(e.requestId, "req-1");
      assert.equal(e.endpoint, "/rest/posts");
      return true;
    });
  }
});

test("createPost: an invalid payload is refused before sending", async () => {
  const { client, calls } = setup(() => ({ status: 201 }));
  await assert.rejects(client.createPost(textPost({ author: "urn:li:company:1" })), outcomeIs(ConfigError, "not_sent"));
  await assert.rejects(client.createPost({ ...textPost(), extra: true } as PostPayload), ConfigError);
  await assert.rejects(client.createPost(textPost({ content: { article: { source: "http://foreachurl.app/en/news/x", title: "X" } } })), ConfigError);
  await assert.rejects(client.createPost(textPost({ content: { media: { id: "urn:li:image:X", altText: "a".repeat(4087) } } })), ConfigError);
  assert.equal(calls.length, 0);
});

test("createArticlePost: formatted commentary, documented article fields", async () => {
  const { client, calls } = setup(() => ({ status: 201, headers: { "x-restli-id": "urn:li:share:7000000000000000004" } }));
  await client.createArticlePost({
    author: ORG,
    text: "WooCommerce (Action Scheduler) – 3 kroki. #WooCommerce",
    article: { source: "https://foreachurl.app/en/news/action-scheduler", title: "Action Scheduler", description: "Case", thumbnail: "urn:li:image:C4E10AQF" },
  });
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.commentary, "WooCommerce \\(Action Scheduler\\) – 3 kroki. #WooCommerce");
  assert.deepEqual(body.content, { article: { source: "https://foreachurl.app/en/news/action-scheduler", title: "Action Scheduler", description: "Case", thumbnail: "urn:li:image:C4E10AQF" } });
  assert.equal(body.visibility, "PUBLIC");
  assert.equal(body.lifecycleState, "PUBLISHED");
});

test("createArticlePost: empty or too long text is a not_sent ConfigError", async () => {
  const { client, calls } = setup(() => ({ status: 201 }));
  const article = { source: "https://foreachurl.app/en/news/x", title: "X" };
  await assert.rejects(client.createArticlePost({ author: ORG, text: "  ", article }), outcomeIs(ConfigError, "not_sent"));
  await assert.rejects(client.createArticlePost({ author: ORG, text: "x".repeat(3001), article }), outcomeIs(ConfigError, "not_sent"));
  assert.equal(calls.length, 0);
});

test("German and Polish text with umlauts, ß, emoji and NFD input is sent as composed UTF-8", async () => {
  const { client, calls } = setup(() => ({ status: 201, headers: { "x-restli-id": "urn:li:share:7000000000000000006" } }));
  const nfd = "Größe der Datenbank – Straße 👍 #Leistungsoptimierung (Teil 1)".normalize("NFD");
  await client.createImagePost({ author: ORG, text: nfd, image: "urn:li:image:C4E10AQF", altText: "Diagramm: Lösung" });
  const sent = JSON.parse(String(calls[0].init.body));
  assert.equal(sent.commentary, "Größe der Datenbank – Straße 👍 #Leistungsoptimierung \\(Teil 1\\)");
  assert.equal(sent.commentary, sent.commentary.normalize("NFC"));
  assert.deepEqual(sent.content, { media: { id: "urn:li:image:C4E10AQF", altText: "Diagramm: Lösung" } });
  assert.match(String(calls[0].init.body), /Größe/); // raw UTF-8, not \u escapes
});

// --- image upload -------------------------------------------------------------------------------

test("image upload: initialize, then PUT the PNG with the token to the documented URL", async () => {
  const { client, calls } = setup((url) =>
    url.includes("initializeUpload") ? { body: { value: { uploadUrlExpiresAt: NOW.getTime() + 3600_000, uploadUrl: UPLOAD_URL, image: "urn:li:image:C4E10AQF" } } } : { status: 201 },
  );
  const u = await client.initializeImageUpload(ORG);
  assert.equal(calls[0].url, `${API_BASE}/images?action=initializeUpload`);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { initializeUploadRequest: { owner: ORG } });
  assert.equal(u.image, "urn:li:image:C4E10AQF");

  await client.uploadImage(u, PNG, NOW);
  assert.equal(calls[1].url, UPLOAD_URL);
  assert.equal(calls[1].init.method, "PUT");
  assert.equal(calls[1].init.redirect, "manual");
  assert.equal(header(calls[1].init, "Authorization"), `Bearer ${FAKE_ACCESS}`);
  assert.equal(header(calls[1].init, "Content-Type"), "image/png");
  assert.equal(header(calls[1].init, "LinkedIn-Version"), null);
  assert.deepEqual(new Uint8Array(calls[1].init.body as Uint8Array), PNG);
});

test("image upload: malicious or undocumented upload URLs are refused, the token is never sent", async () => {
  const bad = [
    "http://www.linkedin.com/dms-uploads/x",
    "https://www.linkedin.com:8443/dms-uploads/x",
    "https://linkedin.com/dms-uploads/x",
    "https://api.linkedin.com/dms-uploads/x",
    "https://media.licdn.com/dms-uploads/x",
    "https://www.linkedin.com.evil.example/dms-uploads/x",
    "https://evil.example/www.linkedin.com/dms-uploads/x",
    "https://www.linkedin.com@evil.example/dms-uploads/x",
    "https://user:pw@www.linkedin.com/dms-uploads/x",
    "https://evil.example\\@www.linkedin.com/dms-uploads/x",
    "https://www.linkedin.com%2f@evil.example/dms-uploads/x",
    "https://www.linkedin.com./dms-uploads/x",
    "https://www.linkedin.com/feed/",
    "https://www.linkedin.com/dms-uploads/../oauth/v2/accessToken",
    "javascript:alert(1)",
    "not a url",
  ];
  for (const uploadUrl of bad) {
    // as returned by initializeUpload: an invalid response
    const init = setup((url) => (url.includes("initializeUpload") ? { body: { value: { uploadUrlExpiresAt: NOW.getTime() + 60_000, uploadUrl, image: "urn:li:image:X1" } } } : { status: 201 }));
    await assert.rejects(init.client.initializeImageUpload(ORG), (e: unknown) => e instanceof InvalidResponseError, uploadUrl);
    // passed in directly: refused before sending
    const direct = setup(() => ({ status: 201 }));
    await assert.rejects(direct.client.uploadImage(upload({ uploadUrl }), PNG, NOW), outcomeIs(ConfigError, "not_sent"), uploadUrl);
    assert.equal(direct.calls.length, 0, uploadUrl);
  }
});

test("image upload: URLs are judged after WHATWG parsing (percent-encoded host = the real host)", async () => {
  const { client, calls } = setup(() => ({ status: 201 }));
  await client.uploadImage(upload({ uploadUrl: "https://www%2elinkedin%2ecom/dms-uploads/x" }), PNG, NOW);
  assert.equal(new URL(calls[0].url).hostname, "www.linkedin.com");
});

test("image upload: invalid initializeUpload answers", async () => {
  for (const body of [{}, { value: {} }, { value: { uploadUrl: UPLOAD_URL, image: "urn:li:share:1", uploadUrlExpiresAt: 1 } }, { value: { uploadUrl: UPLOAD_URL, image: "urn:li:image:X" } }]) {
    const { client } = setup(() => ({ body }));
    await assert.rejects(client.initializeImageUpload(ORG), outcomeIs(InvalidResponseError, "unknown"), JSON.stringify(body));
  }
  const { client } = setup(() => ({ body: "{not json" }));
  await assert.rejects(client.initializeImageUpload(ORG), InvalidResponseError);
  await assert.rejects(client.initializeImageUpload("urn:li:person:abc"), ConfigError);
});

test("image upload: wrong format, too large and expired URL are refused without sending", async () => {
  const { client, calls } = setup(() => ({ status: 201 }));
  await assert.rejects(client.uploadImage(upload(), new TextEncoder().encode("<svg/>"), NOW), /PNG or JPEG/);
  const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
  big.set(PNG);
  await assert.rejects(client.uploadImage(upload(), big, NOW), outcomeIs(ConfigError, "not_sent"));
  await assert.rejects(client.uploadImage(upload({ uploadUrlExpiresAt: NOW.getTime() - 1 }), PNG, NOW), /expired/);
  await client.uploadImage(upload(), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]), NOW); // JPEG is fine
  assert.equal(calls.length, 1);
  assert.equal(header(calls[0].init, "Content-Type"), "image/jpeg");
});

test("image upload: the upload URL never appears in errors", async () => {
  const { client } = setup((url) =>
    url.includes("initializeUpload")
      ? { body: { value: { uploadUrlExpiresAt: NOW.getTime() + 60_000, uploadUrl: UPLOAD_URL, image: "urn:li:image:X1" } } }
      : { throws: new TypeError(`fetch failed for ${UPLOAD_URL}`) },
  );
  const u = await client.initializeImageUpload(ORG);
  await assert.rejects(client.uploadImage(u, PNG, NOW), (e: unknown) => {
    assert.ok(e instanceof NetworkError);
    assert.equal(e.endpoint, "image upload");
    assert.ok(!e.message.includes("08zHQjMjAOLqc1"));
    assert.ok(!JSON.stringify(e.toJSON()).includes("08zHQjMjAOLqc1"));
    return true;
  });
});

// --- redirects, timeouts and failure semantics --------------------------------------------------

test("redirects are not followed and are an unknown outcome", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { client, calls } = setup(() => ({ status, headers: { location: "https://evil.example/steal" } }));
    await assert.rejects(client.createPost(textPost()), (e: unknown) => e instanceof InvalidResponseError && e.outcome === "unknown" && e.status === status && /redirect/.test((e as Error).message));
    assert.equal(calls.length, 1);
  }
  // what fetch returns for redirect: "manual" in browsers
  const typed = (async () => {
    const r = new Response(null, { status: 200 });
    Object.defineProperty(r, "type", { value: "opaqueredirect" });
    Object.defineProperty(r, "status", { value: 0 });
    return r;
  }) as typeof fetch;
  const { client } = setup(() => ({}), {}, { fetchImpl: typed });
  await assert.rejects(client.createPost(textPost()), outcomeIs(InvalidResponseError, "unknown"));
});

test("timeouts: an API call that hangs is aborted as an unknown network failure; uploads have their own limit", async () => {
  const hang = (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
  const { client } = setup(() => ({}), {}, { fetchImpl: hang, timeoutMs: 30, uploadTimeoutMs: 60 });
  const started = Date.now();
  await assert.rejects(client.createPost(textPost()), (e: unknown) => e instanceof NetworkError && e.outcome === "unknown" && /TimeoutError/.test((e as Error).message));
  await assert.rejects(client.uploadImage(upload(), PNG, NOW), outcomeIs(NetworkError, "unknown"));
  assert.ok(Date.now() - started < 5_000);
});

test("error classification: 401, 403, 4xx, 426, 429, 408/409, 5xx, network", async () => {
  const cases: [Reply, (err: unknown) => boolean][] = [
    [{ status: 401, body: { status: 401, serviceErrorCode: 65601, code: "REVOKED_ACCESS_TOKEN", message: "The token used in the request has been revoked by the user" } },
      (e) => e instanceof AuthError && e.outcome === "rejected" && e.reauthorize && e.serviceErrorCode === 65601 && e.code === "REVOKED_ACCESS_TOKEN"],
    [{ status: 403, body: { status: 403, serviceErrorCode: 100, code: "ACCESS_DENIED", message: "Not enough permissions to access: partnerApiPostsExternal.CREATE.20261001" } },
      (e) => e instanceof ApiRefusalError && e.outcome === "rejected" && e.status === 403 && e.code === "ACCESS_DENIED"],
    [{ status: 422, body: { status: 422, message: "Content is a duplicate of urn:li:share:7000000000000000001" } },
      (e) => e instanceof ApiRefusalError && e.outcome === "rejected" && /duplicate/.test(e.message)],
    [{ status: 426, body: { status: 426, code: "NONEXISTENT_VERSION", message: "Requested version 202601 is not active" } },
      (e) => e instanceof ApiRefusalError && /LINKEDIN_API_VERSION/.test(e.message)],
    [{ status: 429, body: { status: 429, message: "Resource level throttle APPLICATION DAY limit for calls to this resource is reached." }, headers: { "retry-after": "120" } },
      (e) => e instanceof RateLimitError && e.outcome === "rejected" && e.retryAfterSeconds === 120],
    [{ status: 429, body: {}, headers: { "retry-after": new Date(Date.now() + 90_000).toUTCString() } },
      (e) => e instanceof RateLimitError && e.retryAfterSeconds !== undefined && e.retryAfterSeconds > 60 && e.retryAfterSeconds <= 91],
    [{ status: 429, body: {} }, (e) => e instanceof RateLimitError && e.retryAfterSeconds === undefined],
    [{ status: 408, body: {} }, (e) => e instanceof ServerError && e.outcome === "unknown"],
    [{ status: 409, body: { message: "Conflict" } }, (e) => e instanceof ServerError && e.outcome === "unknown"],
    [{ status: 500, body: { message: "Internal" } }, (e) => e instanceof ServerError && e.outcome === "unknown"],
    [{ status: 503, body: "upstream unavailable" }, (e) => e instanceof ServerError && e.outcome === "unknown" && e.status === 503],
    [{ status: 504, body: "<html>gateway</html>", headers: { "x-li-uuid": "req-504" } }, (e) => e instanceof ServerError && e.requestId === "req-504"],
    [{ throws: new DOMException("The operation was aborted due to timeout", "TimeoutError") }, (e) => e instanceof NetworkError && e.outcome === "unknown"],
    [{ throws: new TypeError("fetch failed") }, (e) => e instanceof NetworkError && e.method === "POST" && e.endpoint === "/rest/posts"],
  ];
  for (const [reply, check] of cases) {
    const { client, calls } = setup(() => reply);
    await assert.rejects(client.createPost(textPost()), check, JSON.stringify(reply));
    assert.equal(calls.length, 1, "never retried");
  }
});

test("malformed or interrupted answers to reads are invalid responses / network failures", async () => {
  for (const body of ["<html>", "{\"elements\": [", "null", "[]"]) {
    const { client } = setup(() => ({ body }));
    await assert.rejects(client.listPosts(ORG), outcomeIs(InvalidResponseError, "unknown"), body);
  }
  const broken = (async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"elements":'));
        controller.error(new Error("socket hang up"));
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  const { client } = setup(() => ({}), {}, { fetchImpl: broken });
  await assert.rejects(client.listPosts(ORG), outcomeIs(NetworkError, "unknown"));
});

test("not_sent only before a request: a refresh that fails on the network sends no API call", async () => {
  const config = testConfig();
  signedIn(config, { expires_at: "2026-10-21T11:00:00.000Z", refresh_token: FAKE_REFRESH, refresh_token_expires_at: "2027-10-21T12:00:00.000Z" });
  const token = mockFetch(() => ({ throws: new TypeError("fetch failed") }));
  const api = mockFetch(() => ({ status: 201 }));
  const client = new LinkedInClient({ apiVersion: "202610", tokens: new TokenManager(config, { now: () => NOW, fetchImpl: token.impl }), fetchImpl: api.impl });
  await assert.rejects(client.createPost(textPost()), (e: unknown) => {
    assert.ok(e instanceof AuthError);
    assert.equal(e.outcome, "not_sent");
    assert.equal(e.reauthorize, false); // a network problem: try again later, no new sign-in needed
    assert.ok(!e.message.includes(FAKE_REFRESH));
    return true;
  });
  assert.equal(token.calls.length, 1);
  assert.equal(api.calls.length, 0);
});

test("expired token without refresh: no request; revoked token: 401 rejected with reauthorize", async () => {
  const expired = setup(() => ({ status: 201 }), { expires_at: "2026-10-01T00:00:00.000Z" });
  await assert.rejects(expired.client.createPost(textPost()), (e: unknown) => e instanceof AuthError && e.outcome === "not_sent" && e.reauthorize);
  assert.equal(expired.calls.length, 0);
  const revoked = setup(() => ({ status: 401, body: { code: "REVOKED_ACCESS_TOKEN", message: "revoked" } }));
  await assert.rejects(revoked.client.listPosts(ORG), (e: unknown) => e instanceof AuthError && e.outcome === "rejected" && e.reauthorize);
});

test("errors never contain the token, even when LinkedIn echoes it", async () => {
  const { client } = setup(() => ({ status: 400, body: { message: `Bad request with Authorization: Bearer ${FAKE_ACCESS} and access_token=${FAKE_ACCESS}` } }));
  await assert.rejects(client.createPost(textPost()), (err: unknown) => {
    const e = err as ApiRefusalError;
    assert.ok(!e.message.includes(FAKE_ACCESS));
    assert.ok(!JSON.stringify(e.toJSON()).includes(FAKE_ACCESS));
    assert.ok(!(e.stack ?? "").includes(FAKE_ACCESS));
    assert.match(e.message, /\[REDACTED\]/);
    return true;
  });
});
