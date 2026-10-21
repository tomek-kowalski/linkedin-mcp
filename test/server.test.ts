import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { clearSecrets } from "../src/sanitize.js";
import { createContext, createServer } from "../src/server.js";
import { FAKE_ACCESS, FAKE_SECRET, mockFetch, signedIn, tempDir, testConfig } from "./helpers.js";

beforeEach(() => clearSecrets());

function env(dir: string) {
  return {
    LINKEDIN_CLIENT_ID: "77abcdefgh",
    LINKEDIN_CLIENT_SECRET: FAKE_SECRET,
    LINKEDIN_ORGANIZATION_ID: "123456",
    LINKEDIN_API_VERSION: "202610",
    LINKEDIN_TOKEN_FILE: join(dir, "linkedin-token.json"),
    LINKEDIN_REDIRECT_URI: "http://localhost:8765/callback",
  };
}

async function connect(serverEnv: Record<string, string | undefined>, fetchImpl?: typeof fetch) {
  const server = createServer(createContext(serverEnv, fetchImpl));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

test("only the two read-only tools are exposed", async () => {
  const client = await connect({});
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["linkedin_get_organization", "linkedin_list_posts"]);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true);
    assert.equal(t.annotations?.destructiveHint, false);
  }
});

test("incomplete configuration: a configuration error, no request", async () => {
  const { impl, calls } = mockFetch(() => ({ body: {} }));
  const client = await connect({ LINKEDIN_CLIENT_ID: "77abcdefgh" }, impl);
  const r = await client.callTool({ name: "linkedin_get_organization", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(text(r), /ConfigurationError/);
  assert.match(text(r), /LINKEDIN_ORGANIZATION_ID is not set/);
  assert.equal(calls.length, 0);
});

test("not signed in: an auth error telling the owner to run npm run auth", async () => {
  const client = await connect(env(tempDir()));
  const r = await client.callTool({ name: "linkedin_list_posts", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(text(r), /AuthError/);
  assert.match(text(r), /npm run auth/);
  assert.match(text(r), /"outcome": "not_sent"/);
});

test("linkedin_get_organization and linkedin_list_posts for the configured page", async () => {
  const dir = tempDir();
  signedIn({ ...testConfig(dir) });
  const { impl, calls } = mockFetch((url) =>
    url.includes("/organizations/")
      ? { body: { id: 123456, localizedName: "ForeachURL", vanityName: "foreachurl" } }
      : { body: { paging: { start: 5, count: 1, total: 6 }, elements: [{ id: "urn:li:share:1", author: "urn:li:organization:123456", commentary: "Hi" }] } },
  );
  const client = await connect(env(dir), impl);

  const org = await client.callTool({ name: "linkedin_get_organization", arguments: {} });
  assert.equal(org.isError, undefined);
  assert.equal(JSON.parse(text(org)).name, "ForeachURL");

  const posts = await client.callTool({ name: "linkedin_list_posts", arguments: { count: 1, start: 5, sort_by: "CREATED" } });
  const parsed = JSON.parse(text(posts));
  assert.equal(parsed.posts[0].id, "urn:li:share:1");
  assert.deepEqual(parsed.paging, { start: 5, count: 1, next_start: null });
  assert.match(calls[1].url, /author=urn%3Ali%3Aorganization%3A123456/);
  assert.match(calls[1].url, /sortBy=CREATED/);
  assert.ok(!JSON.stringify([text(org), text(posts)]).includes(FAKE_ACCESS));
});

test("invalid tool input is refused by the schema", async () => {
  const client = await connect(env(tempDir()));
  const r = await client.callTool({ name: "linkedin_list_posts", arguments: { count: 500 } });
  assert.equal(r.isError, true);
});
