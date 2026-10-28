import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuthError, ConfigError, NetworkError } from "../src/errors.js";
import { escapeLittleText } from "../src/format.js";
import { approvalCode, publish, type PublishDeps } from "../src/publish.js";
import { NOW, PNG, tempDir } from "./helpers.js";

const ORG = "123456";
const URN = `urn:li:organization:${ORG}`;
const TEXT = "WooCommerce doesn't have to look after the store front (yet).\n\n#WooCommerce #NextJS\n\nhttps://example.com/en/news/headless";

function fakeDeps(opts: { existing?: string[]; create?: "ok" | "network"; typed?: string | null } = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  const dir = tempDir();
  const deps: PublishDeps = {
    organizationId: ORG,
    tokens: { ensureValid: async () => (calls.push("ensureValid"), {} as never) },
    client: {
      listPosts: async () => (calls.push("listPosts"), { posts: (opts.existing ?? []).map((c, i) => ({ id: `urn:li:share:${i + 1}`, author: URN, commentary: c, lifecycle_state: "PUBLISHED", visibility: "PUBLIC", created_at: null, published_at: null, last_modified_at: null, article_source: null, media_id: null })), paging: { start: 0, count: 25, next_start: null } }),
      initializeImageUpload: async () => (calls.push("initializeImageUpload"), { uploadUrl: "https://www.linkedin.com/dms-uploads/x", image: "urn:li:image:abc", uploadUrlExpiresAt: NOW.getTime() + 60_000 }),
      uploadImage: async () => void calls.push("uploadImage"),
      createImagePost: async (i) => {
        calls.push(`createImagePost ${i.image}`);
        return { id: "urn:li:share:99", requestId: "req-1" };
      },
      createTextPost: async () => {
        calls.push("createTextPost");
        if (opts.create === "network") throw new NetworkError("Network error calling LinkedIn (POST /rest/posts): timeout", { method: "POST", endpoint: "/rest/posts" });
        return { id: "urn:li:share:98", requestId: null };
      },
    },
    ask: opts.typed === null ? undefined : async () => opts.typed ?? approvalCode(TEXT, null, URN),
    out: (l) => lines.push(l),
    logFile: join(dir, "content", "publications.jsonl"),
    now: () => NOW,
  };
  const file = join(dir, "post.txt");
  writeFileSync(file, `\uFEFF${TEXT.replace(/\n/g, "\r\n")}\r\n`);
  return { deps, calls, lines, file, dir };
}

test("publish: shows the exact text and posts only with the code for it", async () => {
  const f = fakeDeps();
  const r = await publish({ textFile: f.file, dryRun: false }, f.deps);
  assert.deepEqual(r, { status: "published", id: "urn:li:share:98", requestId: null });
  assert.deepEqual(f.calls, ["ensureValid", "listPosts", "createTextPost"]);
  assert.ok(f.lines.some((l) => l.includes("  | #WooCommerce #NextJS")));
  assert.match(readFileSync(f.deps.logFile!, "utf8"), /"event":"published".*"id":"urn:li:share:98"/);
});

test("publish: a wrong code, no terminal or a dry run post nothing", async () => {
  for (const [opts, dryRun] of [[{ typed: "nope" }, false], [{ typed: null }, false], [{}, true]] as const) {
    const f = fakeDeps(opts);
    const r = await publish({ textFile: f.file, dryRun }, f.deps);
    assert.notEqual(r.status, "published");
    assert.ok(!f.calls.some((c) => c.startsWith("create")), `nothing created (${JSON.stringify(opts)}, dryRun ${dryRun})`);
  }
});

test("publish: an image post uploads first; the code is bound to the image too", async () => {
  const f = fakeDeps({ typed: approvalCode(TEXT, PNG, URN) });
  const image = join(f.dir, "image.png");
  writeFileSync(image, PNG);
  const r = await publish({ textFile: f.file, imageFile: image, dryRun: false }, f.deps);
  assert.equal(r.status, "published");
  assert.deepEqual(f.calls, ["ensureValid", "listPosts", "initializeImageUpload", "uploadImage", "createImagePost urn:li:image:abc"]);
  assert.notEqual(approvalCode(TEXT, PNG, URN), approvalCode(TEXT, null, URN));
});

test("publish: the same text already on the page is not posted again (also after a lost answer)", async () => {
  const lost = fakeDeps({ create: "network" });
  await assert.rejects(publish({ textFile: lost.file, dryRun: false }, lost.deps), (e: unknown) => e instanceof ConfigError && /may exist/.test(e.message));
  assert.match(readFileSync(lost.deps.logFile!, "utf8"), /"event":"failed".*"outcome":"unknown"/);

  // LinkedIn returns the text escaped, with hashtag templates and the link shortened
  const returned = escapeLittleText(TEXT).replace("\\#WooCommerce", "{hashtag|\\#|WooCommerce}").replace(/https:\S+/, "https://lnkd.in/aBc12XyZ");
  const again = fakeDeps({ existing: ["something else", returned] });
  const r = await publish({ textFile: again.file, dryRun: false }, again.deps);
  assert.deepEqual(r, { status: "already_posted", id: "urn:li:share:2" });
  assert.ok(!again.calls.some((c) => c.startsWith("create")));
});

test("publish: without a valid token nothing is listed or sent; empty or too long text is refused locally", async () => {
  const f = fakeDeps();
  f.deps.tokens = { ensureValid: async () => { throw new AuthError("not signed in", "not_sent"); } };
  await assert.rejects(publish({ textFile: f.file, dryRun: false }, f.deps), AuthError);
  assert.deepEqual(f.calls, []);
  writeFileSync(f.file, "   \n");
  await assert.rejects(publish({ textFile: f.file, dryRun: true }, fakeDeps().deps), ConfigError);
  writeFileSync(f.file, "x".repeat(3001));
  await assert.rejects(publish({ textFile: f.file, dryRun: true }, fakeDeps().deps), /3000/);
});
