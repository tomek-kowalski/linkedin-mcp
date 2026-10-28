import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_IMAGE_BYTES, SCOPES, type LinkedInClient } from "./client.js";
import { organizationUrn } from "./config.js";
import { ConfigError, LinkedInError } from "./errors.js";
import { formatCommentary, normalizeText, plainText } from "./format.js";
import type { TokenManager } from "./oauth.js";
import { redactString } from "./sanitize.js";

/**
 * Publishing one post to the Company Page, approved by the owner in their own terminal:
 *
 * - the text comes from a local file (content/, gitignored: post texts never go in this repository);
 * - the token is checked first: without a valid one nothing is sent;
 * - the page's recent posts are searched for the same text: an earlier attempt whose answer
 *   was lost is found instead of posted twice;
 * - the owner sees exactly what will be posted and types a code derived from it
 *   (text, image, organization). Nothing is posted without that code;
 * - writes are never retried; every outcome goes to the local log (content/publications.jsonl).
 */

export interface PublishInput {
  /** path to a UTF-8 text file: exactly the post's text */
  textFile: string;
  /** optional PNG or JPEG */
  imageFile?: string;
  /** optional alternative text for the image */
  altText?: string;
  dryRun: boolean;
}

export interface PublishDeps {
  client: Pick<LinkedInClient, "listPosts" | "initializeImageUpload" | "uploadImage" | "createImagePost" | "createTextPost">;
  tokens: Pick<TokenManager, "ensureValid">;
  organizationId: string;
  /** the owner's terminal; undefined when there is none (then nothing is posted) */
  ask?: (question: string) => Promise<string>;
  out: (line: string) => void;
  /** append-only log; undefined: no log */
  logFile?: string;
  now?: () => Date;
}

export type PublishResult =
  | { status: "published"; id: string; requestId: string | null }
  | { status: "already_posted"; id: string }
  | { status: "dry_run" | "not_approved" };

/** Posts searched for the same text before posting (one finder page). */
export const DUPLICATE_WINDOW = 25;

/** The code the owner types: bound to the exact text, image and organization. */
export function approvalCode(text: string, image: Uint8Array | null, organization: string): string {
  const h = createHash("sha256").update(JSON.stringify([organization, normalizeText(text), image ? createHash("sha256").update(image).digest("hex") : null]));
  return h.digest("hex").slice(0, 6).toUpperCase();
}

export async function publish(input: PublishInput, deps: PublishDeps): Promise<PublishResult> {
  const { out } = deps;
  const now = deps.now ?? (() => new Date());
  const organization = organizationUrn(deps.organizationId);

  // everything that can be checked locally, before any request
  if (!existsSync(input.textFile)) throw new ConfigError(`No such text file: ${input.textFile}`);
  const text = normalizeText(readFileSync(input.textFile, "utf8").replace(/^﻿/, ""));
  try {
    formatCommentary(text);
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
  let image: Uint8Array | null = null;
  if (input.imageFile) {
    if (!existsSync(input.imageFile)) throw new ConfigError(`No such image file: ${input.imageFile}`);
    if (statSync(input.imageFile).size > MAX_IMAGE_BYTES) throw new ConfigError(`The image is larger than ${MAX_IMAGE_BYTES} bytes.`);
    image = new Uint8Array(readFileSync(input.imageFile));
  }

  await deps.tokens.ensureValid(10 * 60_000, [SCOPES.writePosts, SCOPES.readPosts]);

  // an earlier attempt may have posted it already
  const recent = await deps.client.listPosts(organization, { count: DUPLICATE_WINDOW, sortBy: "CREATED" });
  const same = recent.posts.find((p) => withoutUrls(plainText(p.commentary)) === withoutUrls(text));
  if (same) {
    out(`Already on the page: ${same.id}${same.published_at ? ` (published ${same.published_at})` : ""}. Nothing was posted.`);
    log(deps, now, { event: "already_posted", file: input.textFile, id: same.id });
    return { status: "already_posted", id: same.id };
  }

  out(`\n=== What will be posted on ${organization} ===`);
  out(`Image: ${input.imageFile ? `${input.imageFile} (${image!.byteLength} bytes)` : "none (text-only post)"}`);
  if (input.altText) out(`Alt text: ${input.altText}`);
  out(`Text (${[...text].length} characters):`);
  out(text.split("\n").map((l) => `  | ${l}`).join("\n"));

  if (input.dryRun) {
    out("\nDry run: nothing was posted.");
    return { status: "dry_run" };
  }
  if (!deps.ask) {
    out("\nPublishing needs your own interactive terminal: run it yourself (npm run publish -- …). Nothing was posted.");
    return { status: "not_approved" };
  }
  const code = approvalCode(text, image, organization);
  const typed = await deps.ask(`\nPublish exactly this? Type ${code} to publish, anything else to cancel: `);
  if (typed.trim().toUpperCase() !== code) {
    out("Not approved. Nothing was posted.");
    return { status: "not_approved" };
  }

  try {
    let result: { id: string; requestId: string | null };
    if (image) {
      const upload = await deps.client.initializeImageUpload(organization);
      await deps.client.uploadImage(upload, image, now());
      result = await deps.client.createImagePost({ author: organization, text, image: upload.image, altText: input.altText });
    } else {
      result = await deps.client.createTextPost({ author: organization, text });
    }
    out(`Published: ${result.id}${result.requestId ? ` (request ${result.requestId})` : ""}`);
    log(deps, now, { event: "published", file: input.textFile, id: result.id, request_id: result.requestId });
    return { status: "published", ...result };
  } catch (err) {
    if (err instanceof LinkedInError) {
      log(deps, now, { event: "failed", file: input.textFile, ...err.toJSON() });
      if (err.outcome === "unknown") {
        throw new ConfigError(`LinkedIn didn't confirm the post (${err.message}). It may exist: run the same command again, it looks for the post before posting.`);
      }
    }
    throw err;
  }
}

/** LinkedIn returns links shortened (https://lnkd.in/…), so posts are compared without them. */
export const withoutUrls = (text: string) => text.replace(/https?:\/\/\S+/g, "<url>");

function log(deps: PublishDeps, now: () => Date, event: Record<string, unknown>): void {
  if (!deps.logFile) return;
  mkdirSync(dirname(deps.logFile), { recursive: true });
  appendFileSync(deps.logFile, `${redactString(JSON.stringify({ at: now().toISOString(), ...event }))}\n`);
}
