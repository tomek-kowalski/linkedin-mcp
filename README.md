# linkedin-mcp

A LinkedIn REST API client for the ForeachURL Company Page, plus a small local [MCP](https://modelcontextprotocol.io)
server with **read-only** tools.

- **Library:** the OAuth sign-in, the token store and `LinkedInClient` (organization, posts, image upload, post creation).
  `meta-mcp` uses it as a local dependency to publish approved posts.
- **MCP server:** `linkedin_get_organization` and `linkedin_list_posts`. There is no publishing tool.
- **Publishing:** `npm run publish`, run by the owner in their own terminal (see [Publishing](#publishing-npm-run-publish)).

Runtime: Node.js ≥ 20.12, TypeScript, Zod, `@modelcontextprotocol/sdk` (stdio). API: `https://api.linkedin.com/rest`,
versioned (`LinkedIn-Version: YYYYMM`, `X-Restli-Protocol-Version: 2.0.0`).

This repository is public. Content, client data, tokens and private paths never go in it.

## Installation

```sh
cd E:\react\campaign\linkedin-mcp
npm install
npm run build            # outputs dist/
npm test                 # build + unit tests (mocked HTTP, no LinkedIn calls)
```

## Configuration

The configuration lives only in `<package>/.env`, which holds the real credentials and is gitignored: never commit it.
There is no example file; create `.env` locally with the variables below. The bin scripts (`npm run auth`,
`npm run publish`, `npm start`) read it. Variables already set in the environment take precedence.
**Importing the library reads neither `.env` nor `process.env`:** the host passes its configuration explicitly (see [Integration contract](#integration-contract-for-meta-mcp)).

| Variable                   | Required | Description |
| -------------------------- | -------- | ----------- |
| `LINKEDIN_CLIENT_ID`       | yes | Client id of the *ForeachURL Publisher* app. |
| `LINKEDIN_CLIENT_SECRET`   | yes | Client secret. Secret: never logged. |
| `LINKEDIN_ORGANIZATION_ID` | yes | Numeric id of the Company Page (`urn:li:organization:<id>`). |
| `LINKEDIN_API_VERSION`     | yes | Exact version, `YYYYMM` (e.g. `202610`). There is no unversioned default. Versions are supported for at least a year. |
| `LINKEDIN_TOKEN_FILE`      | yes | Absolute path **outside any git repository** (this one, `meta-mcp`, `editorial`) for the token file. |
| `LINKEDIN_REDIRECT_URI`    | yes | `http://localhost:<port>/<path>` or `http://127.0.0.1:<port>/<path>`, registered exactly like this under *Auth → Authorized redirect URLs* in the app. |
| `LINKEDIN_SCOPES`          | no  | Space-separated. Default: `r_organization_social w_organization_social`, which is what publishing needs. Add `rw_organization_admin` for `linkedin_get_organization`, but only once the app has it: LinkedIn rejects the whole sign-in (401 *Invalid scope*) if any requested scope isn't assigned to the app. |

Invalid or missing values are reported by variable name; values are never echoed.

## Signing in (`npm run auth`)

Run this in your own terminal:

```sh
npm run auth               # sign in
npm run auth -- --status   # token state, expiry, scopes, refresh token yes/no (never the token)
```

1. It listens on `LINKEDIN_REDIRECT_URI` (loopback only) and prints LinkedIn's authorization URL. The URL includes a
   random `state`.
2. Open the URL and approve with an account that is an administrator of the Company Page.
3. The redirect is checked:
   - the request target (origin-form only, no `//host`), the `Host` header and the path must match;
   - the `state` is compared in constant time. A request with the wrong state (possible CSRF) is answered 400 and
     **ignored**: it can't inject a code, and it can't end the flow before the genuine redirect arrives;
   - with the right state, LinkedIn's `error` (for example, you cancelled) ends the flow.
4. The code is exchanged at `https://www.linkedin.com/oauth/v2/accessToken`.
5. The tokens are written atomically (temporary file, then rename) to `LINKEDIN_TOKEN_FILE`. A reader sees the old or
   the new tokens, never a partial file. On Windows, a rename blocked by another process reading the file is retried
   for up to about 3.5 s. On POSIX the file is `0600`, and a token file readable by other users is refused, as ssh does.
   On Windows, keep the file under your user profile. The listener closes after the genuine redirect, or after
   5 minutes.

**Tokens:**
- Access tokens live 60 days and are treated as expired 5 minutes early.
- LinkedIn issues refresh tokens only to apps it has enabled them for (approved partners), so they are **optional**.
  When the stored token has one, an expired access token is refreshed automatically: one refresh at a time, stored
  atomically, and the old refresh token is kept if no new one is sent.
- Without one, you run `npm run auth` again before the 60 days are up.
- When no valid token or a required scope is missing, every call fails **before any request is sent**: `AuthError`,
  `outcome: "not_sent"`, `reauthorize: true`.
- A refresh that fails, for whatever reason (refused, network, LinkedIn down), is also `not_sent` for the call that
  needed it. `reauthorize` is `false` when only trying later is needed.
- Concurrent callers in one process share a single refresh. Two processes may each refresh; LinkedIn keeps the
  refresh token, so both results are valid and the last write wins.

## Publishing (`npm run publish`)

```sh
npm run publish -- content/<post>.txt [--image <png|jpg>] [--alt "…"] [--dry-run]
```

- The text file is exactly the post's text (UTF-8). Keep post texts in `content/`, which is gitignored: content never
  goes in this repository.
- The token is checked first (`w_organization_social`, `r_organization_social`); without it nothing is sent.
- The page's 25 most recent posts are searched for the same text. If it's there (for example after an answer was
  lost), nothing is posted again.
- The exact text, image and page are shown, and the owner types a code derived from them. Without the code, without
  an interactive terminal, or with `--dry-run`, nothing is posted.
- With `--image`: upload, then a single-image post. Without it: a text-only post (URLs aren't turned into a preview card).
- Writes are never retried. Every outcome is appended to `content/publications.jsonl`. On an `unknown` outcome, run
  the same command again: it looks for the post before posting.

## MCP server

`.mcp.json` (Claude Code):

```json
{
  "mcpServers": {
    "linkedin": { "command": "node", "args": ["E:/react/campaign/linkedin-mcp/dist/src/index.js"] }
  }
}
```

| Tool | Description |
| ---- | ----------- |
| `linkedin_get_organization` | The configured organization: id, URN, name, vanity name, website. Needs `rw_organization_admin` and the ADMINISTRATOR role (documented for `GET /rest/organizations/{id}`). This is opt-in and not needed for publishing. |
| `linkedin_list_posts` | The organization's posts, newest first. Takes `count` (1–100), `start`, `sort_by` (`LAST_MODIFIED`/`CREATED`) and returns `paging.next_start`. Needs `r_organization_social`. |

Both are annotated read-only. The server starts even with incomplete configuration; the tools then return a
`ConfigurationError`. stdout is reserved for MCP; diagnostics go to stderr, redacted. Tool output is sanitized at this
boundary.

The library itself returns LinkedIn's data unchanged. Redacting look-alikes such as `code=` in a post's text would
break the matching used for duplicate recovery.

## Library API

```ts
import { createLinkedIn, readConfig, organizationUrn, formatCommentary, plainText } from "linkedin-mcp";
```

**Setup**

| Export | Purpose |
| ------ | ------- |
| `readConfig(env)` | Validates an explicit `{ LINKEDIN_*: … }` object and returns a `LinkedInConfig`. |
| `createLinkedIn(config, { fetchImpl?, now?, timeoutMs? })` | Returns `{ client, tokens }`. |

**Tokens**

| Export | Purpose |
| ------ | ------- |
| `tokens.ensureValid(minValidityMs?, scopes?)` | Checks the token before a publication starts: refreshes if possible, otherwise throws `AuthError` (`not_sent`). |
| `tokens.status()` | `missing` / `valid` / `refreshable` / `expired`, expiry, scopes. Never the token. |

**Client**

| Export | Purpose |
| ------ | ------- |
| `client.getOrganization(id)` | `GET /rest/organizations/{id}` (`rw_organization_admin`, page ADMINISTRATOR) |
| `client.listPosts(authorUrn, { start?, count?, sortBy? })` | `GET /rest/posts?q=author&author=…` (finder) |
| `client.initializeImageUpload(orgUrn)` | `POST /rest/images?action=initializeUpload`. Returns `{ uploadUrl, image, uploadUrlExpiresAt }`. The `uploadUrl` must be the documented form, judged on the parsed URL: `https`, host exactly `www.linkedin.com` (`UPLOAD_HOSTS`), default port, no credentials, path under `/dms-uploads/`. Anything else is an `InvalidResponseError` and nothing is uploaded. |
| `client.uploadImage(upload, bytes)` | `PUT` of a PNG or JPEG, at most `MAX_IMAGE_BYTES` (10 MB, an internal limit), to the upload URL, with its own timeout (120 s). The URL is checked again here. |
| `client.createPost(payload)` | `POST /rest/posts` with a complete, already formatted payload (validated by `postPayload`). Returns `{ id, requestId }`: `id` from `x-restli-id` (a URL-encoded value is accepted), `requestId` from `x-li-uuid`. |
| `client.createArticlePost({ author, text, article })` | Link post. LinkedIn doesn't scrape URLs, so `title` (and optional `description`, `thumbnail` image URN) are given. `source` must be https. |
| `client.createImagePost({ author, text, image, altText? })` | Single-image post. |

**Text**

| Export | Purpose |
| ------ | ------- |
| `formatCommentary(text)` | Plain text → LinkedIn "little" text. Normalizes to NFC. Escapes the 15 reserved characters `\ \| { } @ [ ] ( ) < > # * _ ~`. Keeps `#word` hashtags as plain `#word`, as in the Posts API create examples; a hashtag needs a letter, so `#12` stays text. Throws `RangeError` for empty text or more than 3000 characters, counted in code points. The client's helpers turn that into a `ConfigError`. |
| `plainText(commentary)` | The reverse, including LinkedIn's returned `{hashtag\|\#\|word}` templates and mentions, NFC. For matching a post that LinkedIn returns. |
| `normalizeText`, `textLength` | NFC + line breaks + trim; length in code points. |

**Documented vs internal limits.**
- Documented: media `altText` ≤ 4,086 characters; images under 36,152,320 pixels (JPG, GIF, PNG); `count` ≤ 100
  in the posts finder.
- Internal: commentary ≤ 3000 characters (LinkedIn's editor limit; the Posts API only names
  `FIELD_LENGTH_TOO_LONG`); image ≤ 10 MB; PNG/JPEG only.
- Article `title` and `description` have no documented limit, and none is enforced.

Writes are **never retried** by the client.

### Errors

Every error is a `LinkedInError` with an `outcome`:

| Class | When | `outcome` |
| ----- | ---- | --------- |
| `ConfigError` | invalid configuration or input, refused before sending | `not_sent` |
| `AuthError` | not signed in, expired without refresh, missing scope (`not_sent`); HTTP 401 or a refused token request (`rejected`). `reauthorize` says whether to run `npm run auth` | `not_sent` / `rejected` |
| `ApiRefusalError` | HTTP 4xx other than 401/429, e.g. 403 `ACCESS_DENIED`, 422 duplicate. `status`, `serviceErrorCode`, `code` | `rejected` |
| `RateLimitError` | HTTP 429. Daily limits reset at midnight UTC. `retryAfterSeconds` is set only if LinkedIn sends `Retry-After` | `rejected` |
| `ServerError` | HTTP 5xx, 408, 409 | `unknown` |
| `NetworkError` | no answer: connection failure, timeout, an interrupted answer | `unknown` |
| `InvalidResponseError` | a redirect (never followed), or a 2xx that breaks the contract: invalid JSON, post created without a valid `x-restli-id` | `unknown` |

What each `outcome` means:
- `rejected`: nothing was created.
- `unknown`: the post may exist. Look for it with `listPosts` before trying again.

Every error also carries `method`, `endpoint` (a path such as `/rest/posts`, or `image upload`; never a query string or
upload URL), `status`, `serviceErrorCode`, `code` and `requestId` (`x-li-uuid`) for reconciliation and support. A 426
(`NONEXISTENT_VERSION`) says to move `LINKEDIN_API_VERSION` forward.

Messages are redacted when the error is created: registered tokens, codes and the client secret, `access_token=`,
`code=` and `state=` parameters, `Bearer …`, JSON token fields, and the signed upload URL.

## Integration contract for meta-mcp

Phase 2 (not done yet).

**`package.json` of meta-mcp:** `"linkedin-mcp": "file:../linkedin-mcp"`. Build `linkedin-mcp` first (`npm run build`);
the dependency resolves to `dist/src/lib.js` with type declarations.

**Configuration:** meta-mcp passes its own values:

```ts
const config = readConfig({
  LINKEDIN_CLIENT_ID: …, LINKEDIN_CLIENT_SECRET: …, LINKEDIN_ORGANIZATION_ID: …,
  LINKEDIN_API_VERSION: …, LINKEDIN_TOKEN_FILE: …, LINKEDIN_REDIRECT_URI: …,
});
const { client, tokens } = createLinkedIn(config);
```

It can share the token file with this package, since `npm run auth` writes it and both read it.

**What meta-mcp does (this package does none of it):**

1. Before marking anything pending, call `await tokens.ensureValid(10 * 60_000, [SCOPES.writePosts, SCOPES.readPosts])`.
   Publishing never needs `rw_organization_admin`.
   An `AuthError` here means nothing was attempted.
2. Bind the approval hash to the LinkedIn text, its language and `organizationUrn(config.organizationId)`.
3. Choose the post form:
   - Article post: `initializeImageUpload` → `uploadImage(PNG)` → `createArticlePost` with
     `{ source: <live article URL>, title, description, thumbnail: image }`.
   - Image post: `createImagePost`.
4. Before the create call, set `linkedin.status = "pending"` in `state.json`. On `outcome === "unknown"`, set it to
   `"unknown"`. The next attempt first calls `listPosts(orgUrn, { count: 25 })` and matches
   `plainText(post.commentary)` against the sent text (and `article_source` against the link) before posting again.
5. Record `{ id, requestId }` (`urn:li:share:…` / `urn:li:ugcPost:…`) and log the event in `publications.jsonl`.
   On an error, log its `toJSON()`: outcome, status, codes, endpoint and request id. No retry on `unknown` without
   that check.

**Stable surface:** the exports listed above, the error classes and `outcome` values, and the `PostSummary` and
`PostList` shapes. The API version is the host's choice. Move forward before LinkedIn sunsets it, after re-running the
tests.

## Blocked until the Community Management API is approved

The app's *Community Management API* product is **pending**. Until LinkedIn approves it, the authorization screen won't
grant these scopes, and the calls fail with `AuthError` (`not_sent`, missing scope) or HTTP 403 `ACCESS_DENIED`:

| Capability | Scope | Blocked |
| ---------- | ----- | ------- |
| Organization lookup (`linkedin_get_organization`, `getOrganization`) | `rw_organization_admin` (opt-in, not requested by default) | yes |
| Listing the page's posts (`linkedin_list_posts`, `listPosts`), so also duplicate recovery after an unknown outcome | `r_organization_social` | yes |
| Image upload for the organization (`initializeImageUpload`, `uploadImage`) | `w_organization_social` | yes |
| Creating posts as the organization (`createPost`, `createArticlePost`, `createImagePost`) | `w_organization_social` | yes |
| Refresh tokens | enabled per app by LinkedIn (MDP partners) | likely; re-run `npm run auth` every < 60 days until then |
| Signing in (`npm run auth`), token storage, status | (none beyond the app itself) | probably: requesting scopes the app hasn't been given fails the whole sign-in with *Invalid scope* |

Not verified against a live response yet, because of the pending approval:
- the exact `PUT` upload response;
- whether every `uploadUrl` is on `www.linkedin.com/dms-uploads/`. That's the only form documented; another one is
  refused, failing safe, and would need adding to `UPLOAD_HOSTS`;
- whether `paging.links` carries `rel: "next"` for posts. When it doesn't, a full page is treated as "maybe more";
- whether `x-li-uuid` is sent on API responses. It's documented only in upload samples;
- how plain `#word` renders for German and Polish words;
- the 3000-character commentary limit;
- whether `organizationsLookup` works for basic fields without `rw_organization_admin`.

Check these with a dry run and the first real post, approved by the owner.

## Security

- Tokens, the client secret and authorization codes are never logged or returned. All output passes through
  `sanitize.ts`.
- The token file must be an absolute path outside any git repository. It is written atomically, and refused if other
  users can read it (POSIX).
- The OAuth `state` is 32 random bytes, compared in constant time. The listener binds to the loopback host only.
- The bearer token is sent only to `https://api.linkedin.com` and to `https://www.linkedin.com/dms-uploads/…` (parsed,
  exact host, default port, no credentials). Redirects are never followed: `redirect: "manual"`, and a 3xx is
  reported as an `unknown` outcome. API calls time out after 30 s, uploads after 120 s.
- No publishing MCP tool exists; the client never retries writes.
