import { z } from "zod";
import { apiVersionSchema } from "./config.js";
import {
  ApiRefusalError,
  AuthError,
  ConfigError,
  InvalidResponseError,
  NetworkError,
  RateLimitError,
  ServerError,
  type ErrorDetails,
} from "./errors.js";
import { formatCommentary } from "./format.js";
import type { TokenProvider } from "./oauth.js";
import { registerSecret, sanitize } from "./sanitize.js";

/**
 * LinkedIn versioned REST API client (https://api.linkedin.com/rest), Community Management:
 *
 * - every request carries `LinkedIn-Version: <YYYYMM>` and `X-Restli-Protocol-Version: 2.0.0`;
 * - the access token comes from a TokenProvider right before each request and is sent only
 *   in the Authorization header, only to https://api.linkedin.com or a LinkedIn upload URL;
 * - writes are never retried here: a failure carries `outcome` (errors.ts), and on
 *   "unknown" the caller looks for the post with listPosts before trying again.
 *
 * The client publishes nothing by itself: approval, state and duplicate recovery belong to the caller.
 */

export const API_BASE = "https://api.linkedin.com/rest";

export const SCOPES = {
  readPosts: "r_organization_social",
  writePosts: "w_organization_social",
  organizationAdmin: "rw_organization_admin",
} as const;

const ORGANIZATION_URN = /^urn:li:organization:\d{1,20}$/;
const AUTHOR_URN = /^urn:li:(?:organization:\d{1,20}|person:[A-Za-z0-9_-]{1,64})$/;
const IMAGE_URN = /^urn:li:image:[A-Za-z0-9_-]{1,128}$/;
const POST_URN = /^urn:li:(?:share|ugcPost):\d{1,30}$/;

export interface LinkedInClientOptions {
  /** Exact LinkedIn-Version, YYYYMM */
  apiVersion: string;
  tokens: TokenProvider;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface Organization {
  id: string;
  urn: string;
  name: string | null;
  vanity_name: string | null;
  website: string | null;
}

export interface PostSummary {
  id: string;
  author: string;
  commentary: string;
  lifecycle_state: string | null;
  visibility: string | null;
  created_at: string | null;
  published_at: string | null;
  last_modified_at: string | null;
  article_source: string | null;
  media_id: string | null;
}

export interface PostList {
  posts: PostSummary[];
  paging: { start: number; count: number; next_start: number | null };
}

export interface ImageUpload {
  uploadUrl: string;
  image: string;
  /** ms since epoch */
  uploadUrlExpiresAt: number;
}

/** The body of POST /rest/posts, as documented for the Posts API. `commentary` is little-text (format.ts). */
export const postPayload = z
  .object({
    author: z.string().regex(AUTHOR_URN, "author must be urn:li:organization:<id> or urn:li:person:<id>"),
    commentary: z.string().min(1),
    visibility: z.enum(["PUBLIC", "CONNECTIONS", "LOGGED_IN", "CONTAINER"]),
    distribution: z
      .object({
        feedDistribution: z.enum(["MAIN_FEED", "NONE"]),
        targetEntities: z.array(z.unknown()),
        thirdPartyDistributionChannels: z.array(z.unknown()),
      })
      .strict(),
    content: z
      .union([
        z.object({ media: z.object({ id: z.string().regex(IMAGE_URN), altText: z.string().max(4086).optional() }).strict() }).strict(),
        z
          .object({
            article: z
              .object({
                source: z.url({ protocol: /^https$/ }),
                title: z.string().min(1).max(400),
                description: z.string().max(4086).optional(),
                thumbnail: z.string().regex(IMAGE_URN).optional(),
                thumbnailAltText: z.string().max(4086).optional(),
              })
              .strict(),
          })
          .strict(),
      ])
      .optional(),
    lifecycleState: z.literal("PUBLISHED"),
    isReshareDisabledByAuthor: z.boolean(),
  })
  .strict();
export type PostPayload = z.infer<typeof postPayload>;

/** A public post in the main feed, as published by the page. */
const defaults = (): Omit<PostPayload, "author" | "commentary" | "content"> => ({
  visibility: "PUBLIC",
  distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
  lifecycleState: "PUBLISHED",
  isReshareDisabledByAuthor: false,
});

export interface ArticlePostInput {
  author: string;
  /** plain text; escaped here */
  text: string;
  article: { source: string; title: string; description?: string; thumbnail?: string; thumbnailAltText?: string };
}

export interface ImagePostInput {
  author: string;
  /** plain text; escaped here */
  text: string;
  image: string;
  altText?: string;
}

type Method = "GET" | "POST" | "PUT";

interface RequestSpec {
  method: Method;
  url: string;
  scopes: readonly string[];
  json?: unknown;
  bytes?: { data: Uint8Array; contentType: string };
  headers?: Record<string, string>;
}

export class LinkedInClient {
  private readonly apiVersion: string;
  private readonly tokens: TokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: LinkedInClientOptions) {
    const version = apiVersionSchema.safeParse(opts.apiVersion);
    if (!version.success) throw new ConfigError(version.error.issues[0].message);
    this.apiVersion = version.data;
    this.tokens = opts.tokens;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** GET /rest/organizations/{id} (rw_organization_admin, page administrator). */
  async getOrganization(organizationId: string): Promise<Organization> {
    if (!/^\d{1,20}$/.test(organizationId)) throw new ConfigError("The organization id must be numeric.");
    const { body } = await this.request({ method: "GET", url: `${API_BASE}/organizations/${organizationId}`, scopes: [SCOPES.organizationAdmin] });
    const org = z
      .object({
        id: z.union([z.number(), z.string()]),
        localizedName: z.string().optional(),
        vanityName: z.string().optional(),
        localizedWebsite: z.string().optional(),
      })
      .safeParse(body);
    if (!org.success) throw new InvalidResponseError("LinkedIn returned an organization without an id.");
    return {
      id: String(org.data.id),
      urn: `urn:li:organization:${org.data.id}`,
      name: org.data.localizedName ?? null,
      vanity_name: org.data.vanityName ?? null,
      website: org.data.localizedWebsite ?? null,
    };
  }

  /** GET /rest/posts?q=author (r_organization_social): newest first, one page. */
  async listPosts(author: string, options: { start?: number; count?: number; sortBy?: "LAST_MODIFIED" | "CREATED" } = {}): Promise<PostList> {
    if (!AUTHOR_URN.test(author)) throw new ConfigError("author must be urn:li:organization:<id> or urn:li:person:<id>.");
    const start = options.start ?? 0;
    const count = options.count ?? 10;
    if (!Number.isInteger(start) || start < 0) throw new RangeError("start must be a non-negative integer.");
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new RangeError("count must be 1–100.");
    // Rest.li 2.0: the URN is URL-encoded in the query
    const query = `q=author&author=${encodeURIComponent(author)}&start=${start}&count=${count}&sortBy=${options.sortBy ?? "LAST_MODIFIED"}`;
    const { body } = await this.request({
      method: "GET",
      url: `${API_BASE}/posts?${query}`,
      scopes: [SCOPES.readPosts],
      headers: { "X-RestLi-Method": "FINDER" },
    });
    const parsed = z
      .object({
        elements: z.array(z.record(z.string(), z.unknown())),
        paging: z.object({ start: z.number().optional(), count: z.number().optional(), total: z.number().optional() }).loose().optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new InvalidResponseError("LinkedIn returned a post list without elements.");
    const posts = parsed.data.elements.map(toPostSummary);
    const total = parsed.data.paging?.total;
    const more = total !== undefined ? start + posts.length < total : posts.length === count;
    return { posts, paging: { start, count, next_start: more ? start + posts.length : null } };
  }

  /** POST /rest/images?action=initializeUpload (w_organization_social). */
  async initializeImageUpload(owner: string): Promise<ImageUpload> {
    if (!ORGANIZATION_URN.test(owner)) throw new ConfigError("owner must be urn:li:organization:<id>.");
    const { body } = await this.request({
      method: "POST",
      url: `${API_BASE}/images?action=initializeUpload`,
      scopes: [SCOPES.writePosts],
      json: { initializeUploadRequest: { owner } },
    });
    const parsed = z
      .object({ value: z.object({ uploadUrl: z.string(), image: z.string().regex(IMAGE_URN), uploadUrlExpiresAt: z.number() }).loose() })
      .safeParse(body);
    if (!parsed.success) throw new InvalidResponseError("LinkedIn's initializeUpload answer has no uploadUrl or image URN.");
    const v = parsed.data.value;
    assertLinkedInUploadUrl(v.uploadUrl);
    return { uploadUrl: v.uploadUrl, image: v.image, uploadUrlExpiresAt: v.uploadUrlExpiresAt };
  }

  /** PUT the image bytes to the upload URL (with the bearer token, as documented for images). PNG or JPEG. */
  async uploadImage(upload: ImageUpload, image: Uint8Array, now: Date = new Date()): Promise<void> {
    assertLinkedInUploadUrl(upload.uploadUrl);
    const contentType = imageType(image);
    if (!contentType) throw new RangeError("The image must be a PNG or JPEG.");
    if (upload.uploadUrlExpiresAt <= now.getTime()) throw new ConfigError("The upload URL has expired: initialize a new upload.");
    await this.request({ method: "PUT", url: upload.uploadUrl, scopes: [SCOPES.writePosts], bytes: { data: image, contentType } });
  }

  /**
   * POST /rest/posts (w_organization_social) with a complete, already formatted payload.
   * Returns the post URN from the x-restli-id header. Not retried; see the outcome on errors.
   */
  async createPost(payload: PostPayload): Promise<{ id: string }> {
    const valid = postPayload.safeParse(payload);
    if (!valid.success) throw new ConfigError(`Invalid post: ${valid.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const { headers } = await this.request({ method: "POST", url: `${API_BASE}/posts`, scopes: [SCOPES.writePosts], json: valid.data });
    const id = headers.get("x-restli-id") ?? headers.get("x-linkedin-id");
    if (!id || !POST_URN.test(id)) {
      throw new InvalidResponseError("LinkedIn accepted the post but returned no post id: the post may exist, look for it before retrying.");
    }
    return { id };
  }

  /** An article (link) post: LinkedIn doesn't scrape the URL, so title (and description, thumbnail) are given. */
  createArticlePost(input: ArticlePostInput): Promise<{ id: string }> {
    return this.createPost({ ...defaults(), author: input.author, commentary: formatCommentary(input.text), content: { article: input.article } });
  }

  /** A single-image post; `image` is the URN from initializeImageUpload, after uploadImage. */
  createImagePost(input: ImagePostInput): Promise<{ id: string }> {
    const media = input.altText ? { id: input.image, altText: input.altText } : { id: input.image };
    return this.createPost({ ...defaults(), author: input.author, commentary: formatCommentary(input.text), content: { media } });
  }

  private async request(spec: RequestSpec): Promise<{ status: number; headers: Headers; body: unknown }> {
    // the token check comes first: with no valid token, nothing is sent
    const token = await this.tokens.getAccessToken(spec.scopes);
    registerSecret(token);
    const where = describe(spec);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...spec.headers };
    let body: BodyInit | undefined;
    if (spec.bytes) {
      headers["Content-Type"] = spec.bytes.contentType;
      body = new Uint8Array(spec.bytes.data);
    } else {
      headers["LinkedIn-Version"] = this.apiVersion;
      headers["X-Restli-Protocol-Version"] = "2.0.0";
      headers.Accept = "application/json";
      if (spec.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(spec.json);
      }
    }

    let res: Response;
    try {
      res = await this.fetchImpl(spec.url, { method: spec.method, headers, body, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new NetworkError(`Network error calling LinkedIn (${where}): ${msg}`);
    }

    const text = await res.text().catch(() => "");
    let parsed: unknown = undefined;
    let jsonError = false;
    if (text.length) {
      try {
        parsed = JSON.parse(text);
      } catch {
        jsonError = true;
      }
    }

    if (!res.ok) throw errorFor(res, parsed, where);
    if (jsonError) throw new InvalidResponseError(`LinkedIn returned invalid JSON (HTTP ${res.status}) for ${where}.`, { status: res.status });
    return { status: res.status, headers: res.headers, body: parsed === undefined ? {} : sanitize(parsed) };
  }
}

function describe(spec: RequestSpec): string {
  const url = new URL(spec.url);
  return url.hostname === "api.linkedin.com" ? `${spec.method} ${url.pathname}` : `${spec.method} image upload`;
}

function errorFor(res: Response, body: unknown, where: string): Error {
  const b = (body && typeof body === "object" ? body : {}) as { message?: unknown; serviceErrorCode?: unknown; code?: unknown };
  const details: ErrorDetails = {
    status: res.status,
    serviceErrorCode: typeof b.serviceErrorCode === "number" ? b.serviceErrorCode : undefined,
    code: typeof b.code === "string" ? b.code : undefined,
  };
  const reason = typeof b.message === "string" && b.message ? b.message : `HTTP ${res.status}`;
  const text = `LinkedIn ${where}: ${reason}`;
  if (res.status === 401) return new AuthError(`${text}. The token is invalid or revoked: run \`npm run auth\` in linkedin-mcp.`, "rejected", details);
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after"));
    return new RateLimitError(`${text}. Rate limited (limits reset daily at midnight UTC).`, {
      ...details,
      retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : undefined,
    });
  }
  if (res.status >= 500) return new ServerError(`${text}. LinkedIn failed; the outcome of a write is unknown.`, details);
  if (res.status === 403) return new ApiRefusalError(`${text}. Access denied: check the app's products, the token's scopes and the page role.`, details);
  return new ApiRefusalError(text, details);
}

/** The bearer token goes along with the upload, so the URL must be LinkedIn's own, over https. */
function assertLinkedInUploadUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidResponseError("LinkedIn returned an invalid upload URL.");
  }
  const host = url.hostname;
  if (url.protocol !== "https:" || !(host === "linkedin.com" || host.endsWith(".linkedin.com"))) {
    throw new InvalidResponseError("Refusing to send the token to an upload URL outside linkedin.com.");
  }
}

function imageType(b: Uint8Array): "image/png" | "image/jpeg" | null {
  if (b.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}

const iso = (v: unknown) => (typeof v === "number" ? new Date(v).toISOString() : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);

function toPostSummary(p: Record<string, unknown>): PostSummary {
  const content = (p.content ?? {}) as { article?: { source?: unknown }; media?: { id?: unknown } };
  return {
    id: str(p.id) ?? "",
    author: str(p.author) ?? "",
    commentary: str(p.commentary) ?? "",
    lifecycle_state: str(p.lifecycleState),
    visibility: str(p.visibility),
    created_at: iso(p.createdAt),
    published_at: iso(p.publishedAt),
    last_modified_at: iso(p.lastModifiedAt),
    article_source: str(content.article?.source),
    media_id: str(content.media?.id),
  };
}
