import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { API_BASE, LinkedInClient, type PostPayload } from "../src/client.js";
import { ApiRefusalError, AuthError, ConfigError, InvalidResponseError, NetworkError, RateLimitError, ServerError } from "../src/errors.js";
import { TokenManager } from "../src/oauth.js";
import { clearSecrets } from "../src/sanitize.js";
import { FAKE_ACCESS, header, mockFetch, NOW, PNG, signedIn, testConfig, type Reply } from "./helpers.js";

beforeEach(() => clearSecrets());

const ORG = "urn:li:organization:123456";

function setup(responder: (url: string, init: RequestInit) => Reply, tokenOverrides = {}) {
  const config = testConfig();
  signedIn(config, tokenOverrides);
  const { impl, calls } = mockFetch(responder);
  const client = new LinkedInClient({ apiVersion: config.apiVersion, tokens: new TokenManager(config, { now: () => NOW }), fetchImpl: impl });
  return { client, calls };
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

test("the API version must be exact", () => {
  const config = testConfig();
  assert.throws(() => new LinkedInClient({ apiVersion: "2026-10", tokens: new TokenManager(config) }), ConfigError);
});

test("getOrganization: versioned REST headers and a summary", async () => {
  const { client, calls } = setup(() => ({
    body: { id: 123456, localizedName: "ForeachURL", vanityName: "foreachurl", localizedWebsite: "https://foreachurl.app", $URN: "urn:li:organization:123456" },
  }));
  const org = await client.getOrganization("123456");
  assert.deepEqual(org, { id: "123456", urn: ORG, name: "ForeachURL", vanity_name: "foreachurl", website: "https://foreachurl.app" });
  const { url, init } = calls[0];
  assert.equal(url, `${API_BASE}/organizations/123456`);
  assert.equal(init.method, "GET");
  assert.equal(header(init, "Authorization"), `Bearer ${FAKE_ACCESS}`);
  assert.equal(header(init, "LinkedIn-Version"), "202610");
  assert.equal(header(init, "X-Restli-Protocol-Version"), "2.0.0");
  await assert.rejects(client.getOrganization("../me"), ConfigError);
});

test("listPosts: finder by author, encoded URN, mapped posts and paging", async () => {
  const { client, calls } = setup(() => ({
    body: {
      paging: { start: 0, count: 2, links: [] },
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
        { id: "urn:li:ugcPost:7000000000000000002", author: ORG, commentary: "Image", content: { media: { id: "urn:li:image:C4E10AQF" } } },
      ],
    },
  }));
  const list = await client.listPosts(ORG, { count: 2 });
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, `${API_BASE}/posts`);
  assert.equal(url.searchParams.get("q"), "author");
  assert.equal(url.searchParams.get("author"), ORG);
  assert.match(calls[0].url, /author=urn%3Ali%3Aorganization%3A123456/);
  assert.equal(url.searchParams.get("count"), "2");
  assert.equal(url.searchParams.get("sortBy"), "LAST_MODIFIED");
  assert.equal(header(calls[0].init, "X-RestLi-Method"), "FINDER");
  assert.equal(list.posts.length, 2);
  assert.equal(list.posts[0].article_source, "https://foreachurl.app/en/news/x");
  assert.equal(list.posts[0].created_at, new Date(1792000000000).toISOString());
  assert.equal(list.posts[1].media_id, "urn:li:image:C4E10AQF");
  assert.deepEqual(list.paging, { start: 0, count: 2, next_start: 2 });
  await assert.rejects(client.listPosts("urn:li:organization:1&q=x"), ConfigError);
  await assert.rejects(client.listPosts(ORG, { count: 101 }), RangeError);
});

test("listPosts: no read scope means no request", async () => {
  const { client, calls } = setup(() => ({ body: { elements: [] } }), { scopes: ["w_organization_social"] });
  await assert.rejects(client.listPosts(ORG), (err: unknown) => err instanceof AuthError && err.outcome === "not_sent");
  assert.equal(calls.length, 0);
});

test("createPost: 201 with the post id in x-restli-id", async () => {
  const { client, calls } = setup(() => ({ status: 201, body: "", headers: { "x-restli-id": "urn:li:share:7000000000000000003" } }));
  assert.deepEqual(await client.createPost(textPost()), { id: "urn:li:share:7000000000000000003" });
  assert.equal(calls[0].url, `${API_BASE}/posts`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(header(calls[0].init, "Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), textPost());
});

test("createPost: success without an id is an unknown outcome", async () => {
  const { client } = setup(() => ({ status: 201, body: "" }));
  await assert.rejects(client.createPost(textPost()), (err: unknown) => err instanceof InvalidResponseError && err.outcome === "unknown");
});

test("createPost: an invalid payload is refused before sending", async () => {
  const { client, calls } = setup(() => ({ status: 201 }));
  await assert.rejects(client.createPost(textPost({ author: "urn:li:company:1" })), ConfigError);
  await assert.rejects(client.createPost({ ...textPost(), extra: true } as PostPayload), ConfigError);
  assert.equal(calls.length, 0);
});

test("createArticlePost: escaped commentary, https article with explicit title and thumbnail", async () => {
  const { client, calls } = setup(() => ({ status: 201, headers: { "x-restli-id": "urn:li:share:7000000000000000004" } }));
  await client.createArticlePost({
    author: ORG,
    text: "WooCommerce (Action Scheduler) – 3 kroki. #WooCommerce",
    article: { source: "https://foreachurl.app/en/news/action-scheduler", title: "Action Scheduler", description: "Case", thumbnail: "urn:li:image:C4E10AQF" },
  });
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.commentary, "WooCommerce \\(Action Scheduler\\) – 3 kroki. {hashtag|\\#|WooCommerce}");
  assert.deepEqual(body.content, { article: { source: "https://foreachurl.app/en/news/action-scheduler", title: "Action Scheduler", description: "Case", thumbnail: "urn:li:image:C4E10AQF" } });
  assert.equal(body.visibility, "PUBLIC");
  assert.equal(body.lifecycleState, "PUBLISHED");
  await assert.rejects(client.createArticlePost({ author: ORG, text: "x", article: { source: "http://foreachurl.app/en/news/x", title: "X" } }), ConfigError);
});

test("createImagePost: media content with alt text", async () => {
  const { client, calls } = setup(() => ({ status: 201, headers: { "x-restli-id": "urn:li:ugcPost:7000000000000000005" } }));
  assert.deepEqual(await client.createImagePost({ author: ORG, text: "Post", image: "urn:li:image:C4E10AQF", altText: "Diagram" }), { id: "urn:li:ugcPost:7000000000000000005" });
  assert.deepEqual(JSON.parse(String(calls[0].init.body)).content, { media: { id: "urn:li:image:C4E10AQF", altText: "Diagram" } });
});

test("image upload: initialize, then PUT the PNG with the token to LinkedIn's URL", async () => {
  const uploadUrl = "https://www.linkedin.com/dms-uploads/sp/abc123/uploadedImage/0?ca=vector_ads";
  const { client, calls } = setup((url) =>
    url.includes("initializeUpload")
      ? { body: { value: { uploadUrlExpiresAt: NOW.getTime() + 3600_000, uploadUrl, image: "urn:li:image:C4E10AQF" } } }
      : { status: 201 },
  );
  const upload = await client.initializeImageUpload(ORG);
  assert.equal(calls[0].url, `${API_BASE}/images?action=initializeUpload`);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { initializeUploadRequest: { owner: ORG } });
  assert.equal(upload.image, "urn:li:image:C4E10AQF");

  await client.uploadImage(upload, PNG, NOW);
  assert.equal(calls[1].url, uploadUrl);
  assert.equal(calls[1].init.method, "PUT");
  assert.equal(header(calls[1].init, "Authorization"), `Bearer ${FAKE_ACCESS}`);
  assert.equal(header(calls[1].init, "Content-Type"), "image/png");
  assert.equal(header(calls[1].init, "LinkedIn-Version"), null);
  assert.deepEqual(new Uint8Array(calls[1].init.body as Uint8Array), PNG);
});

test("image upload: foreign upload URL, wrong format and expired URL are refused without sending", async () => {
  const { client, calls } = setup((url) =>
    url.includes("initializeUpload") ? { body: { value: { uploadUrlExpiresAt: 1, uploadUrl: "https://evil.example/upload", image: "urn:li:image:X1" } } } : { status: 201 },
  );
  await assert.rejects(client.initializeImageUpload(ORG), (err: unknown) => err instanceof InvalidResponseError && /outside linkedin\.com/.test(err.message));
  const sent = calls.length;
  const good = { uploadUrl: "https://www.linkedin.com/dms-uploads/x", image: "urn:li:image:X1", uploadUrlExpiresAt: NOW.getTime() + 60_000 };
  await assert.rejects(client.uploadImage({ ...good, uploadUrl: "http://www.linkedin.com/dms-uploads/x" }, PNG, NOW), /outside linkedin\.com/);
  await assert.rejects(client.uploadImage({ ...good, uploadUrl: "https://linkedin.com.evil.example/x" }, PNG, NOW), /outside linkedin\.com/);
  await assert.rejects(client.uploadImage(good, new TextEncoder().encode("<svg/>"), NOW), /PNG or JPEG/);
  await assert.rejects(client.uploadImage({ ...good, uploadUrlExpiresAt: NOW.getTime() - 1 }, PNG, NOW), /expired/);
  assert.equal(calls.length, sent);
  await assert.rejects(client.initializeImageUpload("urn:li:person:abc"), ConfigError);
});

test("error classification: 401, 403, 400, 429, 5xx, network, invalid JSON", async () => {
  const cases: [Reply, (err: unknown) => boolean][] = [
    [{ status: 401, body: { status: 401, serviceErrorCode: 65601, code: "REVOKED_ACCESS_TOKEN", message: "The token used in the request has been revoked by the user" } },
      (e) => e instanceof AuthError && e.outcome === "rejected" && e.reauthorize && e.serviceErrorCode === 65601],
    [{ status: 403, body: { status: 403, serviceErrorCode: 100, code: "ACCESS_DENIED", message: "Not enough permissions to access: partnerApiPostsExternal.CREATE.20261001" } },
      (e) => e instanceof ApiRefusalError && e.outcome === "rejected" && e.status === 403 && e.code === "ACCESS_DENIED"],
    [{ status: 422, body: { status: 422, message: "Content is a duplicate of urn:li:share:7000000000000000001" } },
      (e) => e instanceof ApiRefusalError && /duplicate/.test(e.message)],
    [{ status: 429, body: { status: 429, message: "Resource level throttle APPLICATION DAY limit for calls to this resource is reached." }, headers: { "retry-after": "120" } },
      (e) => e instanceof RateLimitError && e.outcome === "rejected" && e.retryAfterSeconds === 120],
    [{ status: 429, body: {} }, (e) => e instanceof RateLimitError && e.retryAfterSeconds === undefined],
    [{ status: 503, body: "upstream unavailable" }, (e) => e instanceof ServerError && e.outcome === "unknown"],
    [{ throws: new DOMException("The operation was aborted due to timeout", "TimeoutError") }, (e) => e instanceof NetworkError && e.outcome === "unknown"],
    [{ throws: new TypeError("fetch failed") }, (e) => e instanceof NetworkError && /fetch failed/.test((e as Error).message)],
  ];
  for (const [reply, check] of cases) {
    const { client } = setup(() => reply);
    await assert.rejects(client.createPost(textPost()), check, JSON.stringify(reply));
  }
  const { client } = setup(() => ({ body: "<html>" }));
  await assert.rejects(client.getOrganization("123456"), (e: unknown) => e instanceof InvalidResponseError && e.outcome === "unknown");
});

test("errors never contain the token, even when LinkedIn echoes it", async () => {
  const { client } = setup(() => ({ status: 400, body: { message: `Bad request with Authorization: Bearer ${FAKE_ACCESS} and access_token=${FAKE_ACCESS}` } }));
  await assert.rejects(client.createPost(textPost()), (err: unknown) => {
    const e = err as ApiRefusalError;
    assert.ok(!e.message.includes(FAKE_ACCESS));
    assert.ok(!JSON.stringify(e.toJSON()).includes(FAKE_ACCESS));
    assert.match(e.message, /\[REDACTED\]/);
    return true;
  });
});
