import { z } from "zod";
import { apiVersionSchema } from "./config.js";
import {
  ApiRefusalError,
  AuthError,
  ConfigError,
  InvalidResponseError,
  LinkedInError,
  NetworkError,
  RateLimitError,
  ServerError,
  type ErrorDetails,
} from "./errors.js";
import { formatCommentary } from "./format.js";
import type { TokenProvider } from "./oauth.js";
import { registerSecret } from "./sanitize.js";

/**
 * LinkedIn versioned REST API client (https://api.linkedin.com/rest), Community Management:
 *
 * - every API request carries `LinkedIn-Version: <YYYYMM>` and `X-Restli-Protocol-Version: 2.0.0`;
 * - the access token comes from a TokenProvider right before each request and is sent only
 *   in the Authorization header, only to https://api.linkedin.com or a documented upload URL;
 * - redirects are never followed (the token must not travel on);
 * - writes are never retried here: a failure carries `outcome` (errors.ts), and on
 *   "unknown" the caller looks for the post with listPosts before trying again;
 * - response data is returned as LinkedIn sent it (no redaction, which would alter post
 *   text and break matching); MCP output is sanitized at the tool boundary.
 *
 * The client publishes nothing by itself: approval, state and duplicate recovery belong to the caller.
 */

export const API_BASE = "https://api.linkedin.com/rest";

/** Documented uploadUrl host and paths (Images, Documents, Videos APIs): https://www.linkedin.com/dms-uploads/… */
export const UPLOAD_HOSTS = ["www.linkedin.com"] as const;
const UPLOAD_PATH = /^\/dms-uploads\//;

/** Internal limit (LinkedIn documents only a pixel limit, 36,152,320 px): editorial images are far smaller. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const SCOPES = {
  readPosts: "r_organization_social",
  writePosts: "w_organization_social",
  /** only for getOrganization; not needed for publishing */
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
  /** API requests (default 30 s) */
  timeoutMs?: number;
  /** image uploads (default 120 s) */
  uploadTimeoutMs?: number;
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
  /** as LinkedIn returns it (little text format); plainText() turns it back into the sent text */
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

/**
 * The body of POST /rest/posts, as documented for the Posts API. `commentary` is little text
 * (format.ts). Only documented limits are enforced here (media altText: 4,086 characters).
 */
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
                title: z.string().min(1),
                description: z.string().optional(),
                thumbnail: z.string().regex(IMAGE_URN).optional(),
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
  /** plain text; formatted here */
  text: string;
  /** LinkedIn doesn't scrape the URL: the documented fields are source, title, description, thumbnail */
  article: { source: string; title: string; description?: string; thumbnail?: string };
}

export interface ImagePostInput {
  author: string;
  /** plain text; formatted here */
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
  /** the caller needs the body (a lost body is then a network failure) */
  expectBody: boolean;
}

export class LinkedInClient {
  private readonly apiVersion: string;
  private readonly tokens: TokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;

  constructor(opts: LinkedInClientOptions) {
    const version = apiVersionSchema.safeParse(opts.apiVersion);
    if (!version.success) throw new ConfigError(version.error.issues[0].message);
    this.apiVersion = version.data;
    this.tokens = opts.tokens;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.uploadTimeoutMs = opts.uploadTimeoutMs ?? 120_000;
  }

  /**
   * GET /rest/organizations/{id}. Documented for members with the ADMINISTRATOR role and the
   * rw_organization_admin scope; publishing doesn't need either (see README).
   */
  async getOrganization(organizationId: string): Promise<Organization> {
    if (!/^\d{1,20}$/.test(organizationId)) throw new ConfigError("The organization id must be numeric.");
    const { body, details } = await this.request({ method: "GET", url: `${API_BASE}/organizations/${organizationId}`, scopes: [SCOPES.organizationAdmin], expectBody: true });
    const org = z
      .object({
        id: z.union([z.number(), z.string()]),
        localizedName: z.string().optional(),
        vanityName: z.string().optional(),
        localizedWebsite: z.string().optional(),
      })
      .safeParse(body);
    if (!org.success) throw new InvalidResponseError("LinkedIn returned an organization without an id.", details);
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
    if (!Number.isInteger(start) || start < 0) throw new ConfigError("start must be a non-negative integer.");
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new ConfigError("count must be 1–100.");
    const sortBy = options.sortBy ?? "LAST_MODIFIED";
    if (sortBy !== "LAST_MODIFIED" && sortBy !== "CREATED") throw new ConfigError("sortBy must be LAST_MODIFIED or CREATED.");
    // Rest.li 2.0: the URN is URL-encoded in the query
    const query = `q=author&author=${encodeURIComponent(author)}&start=${start}&count=${count}&sortBy=${sortBy}`;
    const { body, details } = await this.request({
      method: "GET",
      url: `${API_BASE}/posts?${query}`,
      scopes: [SCOPES.readPosts],
      headers: { "X-RestLi-Method": "FINDER" },
      expectBody: true,
    });
    const parsed = z
      .object({
        elements: z.array(z.record(z.string(), z.unknown())),
        paging: z
          .object({
            total: z.number().optional(),
            links: z.array(z.object({ rel: z.string().optional() }).loose()).optional(),
          })
          .loose()
          .optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new InvalidResponseError("LinkedIn returned a post list without elements.", details);
    const posts = parsed.data.elements.map(toPostSummary);
    // documented: paging.links carries the next page; total when present; else a full page suggests more
    const paging = parsed.data.paging;
    const more =
      paging?.links?.some((l) => l.rel === "next") ||
      (paging?.total !== undefined ? start + posts.length < paging.total : posts.length === count && posts.length > 0);
    return { posts, paging: { start, count, next_start: more ? start + posts.length : null } };
  }

  /** POST /rest/images?action=initializeUpload (w_organization_social). */
  async initializeImageUpload(owner: string): Promise<ImageUpload> {
    if (!ORGANIZATION_URN.test(owner)) throw new ConfigError("owner must be urn:li:organization:<id>.");
    const { body, details } = await this.request({
      method: "POST",
      url: `${API_BASE}/images?action=initializeUpload`,
      scopes: [SCOPES.writePosts],
      json: { initializeUploadRequest: { owner } },
      expectBody: true,
    });
    const parsed = z
      .object({ value: z.object({ uploadUrl: z.string(), image: z.string().regex(IMAGE_URN), uploadUrlExpiresAt: z.number() }).loose() })
      .safeParse(body);
    if (!parsed.success) throw new InvalidResponseError("LinkedIn's initializeUpload answer has no uploadUrl or image URN.", details);
    const v = parsed.data.value;
    assertUploadUrl(v.uploadUrl, details);
    registerSecret(v.uploadUrl); // a signed, short-lived capability
    return { uploadUrl: v.uploadUrl, image: v.image, uploadUrlExpiresAt: v.uploadUrlExpiresAt };
  }

  /** PUT the image bytes to the upload URL (with the bearer token, as documented for images). PNG or JPEG. */
  async uploadImage(upload: ImageUpload, image: Uint8Array, now: Date = new Date()): Promise<void> {
    assertUploadUrl(upload.uploadUrl, { method: "PUT", endpoint: "image upload" }, ConfigError);
    const contentType = imageType(image);
    if (!contentType) throw new ConfigError("The image must be a PNG or JPEG.");
    if (image.byteLength > MAX_IMAGE_BYTES) throw new ConfigError(`The image is ${image.byteLength} bytes; the limit is ${MAX_IMAGE_BYTES}.`);
    if (upload.uploadUrlExpiresAt <= now.getTime()) throw new ConfigError("The upload URL has expired: initialize a new upload.");
    await this.request({ method: "PUT", url: upload.uploadUrl, scopes: [SCOPES.writePosts], bytes: { data: image, contentType }, expectBody: false });
  }

  /**
   * POST /rest/posts (w_organization_social) with a complete, already formatted payload.
   * Returns the post URN from the x-restli-id header. Not retried; see the outcome on errors.
   */
  async createPost(payload: PostPayload): Promise<{ id: string; requestId: string | null }> {
    const valid = postPayload.safeParse(payload);
    if (!valid.success) throw new ConfigError(`Invalid post: ${valid.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const { headers, details } = await this.request({ method: "POST", url: `${API_BASE}/posts`, scopes: [SCOPES.writePosts], json: valid.data, expectBody: false });
    const id = postId(headers.get("x-restli-id"));
    if (!id) {
      throw new InvalidResponseError("LinkedIn accepted the post but returned no post id: the post may exist, look for it before retrying.", details);
    }
    return { id, requestId: details.requestId ?? null };
  }

  /** An article (link) post: LinkedIn doesn't scrape the URL, so title (and description, thumbnail) are given. */
  async createArticlePost(input: ArticlePostInput): Promise<{ id: string; requestId: string | null }> {
    return this.createPost({ ...defaults(), author: input.author, commentary: commentary(input.text), content: { article: input.article } });
  }

  /** A single-image post; `image` is the URN from initializeImageUpload, after uploadImage. */
  async createImagePost(input: ImagePostInput): Promise<{ id: string; requestId: string | null }> {
    const media = input.altText ? { id: input.image, altText: input.altText } : { id: input.image };
    return this.createPost({ ...defaults(), author: input.author, commentary: commentary(input.text), content: { media } });
  }

  private async request(spec: RequestSpec): Promise<{ headers: Headers; body: unknown; details: ErrorDetails }> {
    const upload = !spec.url.startsWith(`${API_BASE}/`);
    const base: ErrorDetails = { method: spec.method, endpoint: upload ? "image upload" : new URL(spec.url).pathname };
    // the token check comes first: with no valid token, nothing is sent. Any failure here
    // (including a refresh that failed on the network) happened before the request.
    let token: string;
    try {
      token = await this.tokens.getAccessToken(spec.scopes);
    } catch (err) {
      if (err instanceof LinkedInError && err.outcome === "not_sent") throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new AuthError(`No usable LinkedIn token (${reason}); nothing was sent.`, "not_sent", { ...base, reauthorize: err instanceof AuthError });
    }
    registerSecret(token);
    const where = `${spec.method} ${base.endpoint}`;
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
      res = await this.fetchImpl(spec.url, {
        method: spec.method,
        headers,
        body,
        // never follow: a redirect would carry the token elsewhere; it's reported below
        redirect: "manual",
        signal: AbortSignal.timeout(upload ? this.uploadTimeoutMs : this.timeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new NetworkError(`Network error calling LinkedIn (${where}): ${msg}`, base);
    }
    const details: ErrorDetails = { ...base, status: res.status, requestId: res.headers.get("x-li-uuid") ?? undefined };

    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      throw new InvalidResponseError(`LinkedIn answered ${where} with a redirect (HTTP ${res.status}); not followed.`, details);
    }

    let text = "";
    let readFailed = false;
    try {
      text = await res.text();
    } catch {
      readFailed = true;
    }
    let parsed: unknown = undefined;
    let jsonError = false;
    if (text.length) {
      try {
        parsed = JSON.parse(text);
      } catch {
        jsonError = true;
      }
    }

    if (!res.ok) throw errorFor(res, parsed, where, details);
    if (readFailed && spec.expectBody) throw new NetworkError(`The answer to ${where} was interrupted (HTTP ${res.status}).`, details);
    if (jsonError && spec.expectBody) throw new InvalidResponseError(`LinkedIn returned invalid JSON (HTTP ${res.status}) for ${where}.`, details);
    return { headers: res.headers, body: parsed === undefined ? {} : parsed, details };
  }
}

/** Plain text → commentary; a text that can't be posted is a ConfigError (nothing sent). */
function commentary(text: string): string {
  try {
    return formatCommentary(text);
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
}

function errorFor(res: Response, body: unknown, where: string, details: ErrorDetails): LinkedInError {
  const b = (body && typeof body === "object" ? body : {}) as { message?: unknown; serviceErrorCode?: unknown; code?: unknown };
  const d: ErrorDetails = {
    ...details,
    serviceErrorCode: typeof b.serviceErrorCode === "number" ? b.serviceErrorCode : undefined,
    code: typeof b.code === "string" ? b.code : undefined,
  };
  const reason = typeof b.message === "string" && b.message ? b.message : `HTTP ${res.status}`;
  const text = `LinkedIn ${where}: ${reason}`;
  if (res.status === 401) return new AuthError(`${text}. The token is invalid or revoked: run \`npm run auth\` in linkedin-mcp.`, "rejected", d);
  if (res.status === 429) return new RateLimitError(`${text}. Rate limited (limits reset daily at midnight UTC).`, { ...d, retryAfterSeconds: retryAfter(res.headers.get("retry-after")) });
  if (res.status >= 500 || res.status === 408 || res.status === 409) {
    return new ServerError(`${text}. The outcome of a write is unknown: check before retrying.`, d);
  }
  if (res.status === 403) return new ApiRefusalError(`${text}. Access denied: check the app's products, the token's scopes and the page role.`, d);
  if (res.status === 426) return new ApiRefusalError(`${text}. The LinkedIn-Version is not active: move LINKEDIN_API_VERSION forward.`, d);
  return new ApiRefusalError(text, d);
}

/** Retry-After as seconds or an HTTP date (LinkedIn doesn't document it; used when sent). */
function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) || undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(1, Math.ceil((at - now) / 1000));
}

/** x-restli-id is documented as the raw URN; a URL-encoded one is accepted too. */
function postId(header: string | null): string | null {
  if (!header) return null;
  let value = header.trim();
  if (value.includes("%")) {
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return POST_URN.test(value) ? value : null;
}

/**
 * The bearer token goes along with the upload, so the URL must be the documented one:
 * https, host exactly www.linkedin.com (parsed, not string-matched), default port,
 * no credentials, path under /dms-uploads/.
 */
function assertUploadUrl(value: string, details: ErrorDetails, Err: new (message: string, details: ErrorDetails) => LinkedInError = InvalidResponseError): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Err("The upload URL is not a valid URL.", details);
  }
  const ok =
    url.protocol === "https:" &&
    (UPLOAD_HOSTS as readonly string[]).includes(url.hostname) &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    UPLOAD_PATH.test(url.pathname);
  if (!ok) throw new Err("Refusing to send the token to an upload URL other than https://www.linkedin.com/dms-uploads/….", details);
}

function imageType(b: Uint8Array): "image/png" | "image/jpeg" | null {
  if (b.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}

const iso = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);

function toPostSummary(p: Record<string, unknown>): PostSummary {
  const content = (p.content && typeof p.content === "object" ? p.content : {}) as { article?: { source?: unknown }; media?: { id?: unknown } };
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
