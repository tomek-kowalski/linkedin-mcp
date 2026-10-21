# linkedin-mcp

A LinkedIn REST API client for the ForeachURL Company Page, plus a small local [MCP](https://modelcontextprotocol.io)
server with **read-only** tools.

- **Library:** the OAuth sign-in, the token store and `LinkedInClient` (organization, posts, image upload, post creation).
  `meta-mcp` uses it as a local dependency to publish approved posts.
- **MCP server:** `linkedin_get_organization` and `linkedin_list_posts`. There is no publishing tool. Posting goes only
  through the approval-gated workflow in `meta-mcp`, which owns approval, `state.json`, the publication log and
  duplicate recovery.

Runtime: Node.js ≥ 20.12, TypeScript, Zod, `@modelcontextprotocol/sdk` (stdio). API: `https://api.linkedin.com/rest`,
versioned (`LinkedIn-Version: YYYYMM`, `X-Restli-Protocol-Version: 2.0.0`).

This repository is public. Content, client data, tokens and private paths never go in it.

## Installation

```sh
cd E:\react\campaign\linkedin-mcp
npm install
cp .env.example .env     # fill in locally; never commit .env
npm run build            # outputs dist/
npm test                 # build + unit tests (mocked HTTP, no LinkedIn calls)
```

## Configuration

The bin scripts (`npm run auth`, `npm start`) read `<package>/.env`. Variables already set in the environment take
precedence. **Importing the library reads neither `.env` nor `process.env`:** the host passes its configuration
explicitly (see [Integration contract](#integration-contract-for-meta-mcp)).

| Variable                   | Required | Description |
| -------------------------- | -------- | ----------- |
| `LINKEDIN_CLIENT_ID`       | yes | Client id of the *ForeachURL Publisher* app. |
| `LINKEDIN_CLIENT_SECRET`   | yes | Client secret. Secret: never logged. |
| `LINKEDIN_ORGANIZATION_ID` | yes | Numeric id of the Company Page (`urn:li:organization:<id>`). |
| `LINKEDIN_API_VERSION`     | yes | Exact version, `YYYYMM` (e.g. `202610`). There is no unversioned default. Versions are supported for at least a year. |
| `LINKEDIN_TOKEN_FILE`      | yes | Absolute path **outside this repository** for the token file. |
| `LINKEDIN_REDIRECT_URI`    | yes | `http://localhost:<port>/<path>` or `http://127.0.0.1:<port>/<path>`, registered exactly like this under *Auth → Authorized redirect URLs* in the app. |
| `LINKEDIN_SCOPES`          | no  | Space-separated. Default: `r_organization_social w_organization_social rw_organization_admin`. |

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
   - the path must match;
   - the `state` is compared in constant time, and a mismatch is refused as possible CSRF;
   - LinkedIn's `error` is reported.
4. The code is exchanged at `https://www.linkedin.com/oauth/v2/accessToken`.
5. The tokens are written atomically (temporary file, then rename) to `LINKEDIN_TOKEN_FILE`, with owner-only
   permissions where the file system supports them. On Windows, keep the file under your user profile. The listener
   closes after the first redirect, or after 5 minutes.

**Tokens:**
- Access tokens live 60 days and are treated as expired 5 minutes early.
- LinkedIn issues refresh tokens only to apps it has enabled them for (approved partners), so they are **optional**.
  When the stored token has one, an expired access token is refreshed automatically: one refresh at a time, stored
  atomically, and the old refresh token is kept if no new one is sent.
- Without one, you run `npm run auth` again before the 60 days are up.
- When no valid token or a required scope is missing, every call fails **before any request is sent**: `AuthError`,
  `outcome: "not_sent"`, `reauthorize: true`.

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
| `linkedin_get_organization` | The configured organization: id, URN, name, vanity name, website. Needs `rw_organization_admin`. |
| `linkedin_list_posts` | The organization's posts, newest first. Takes `count` (1–100), `start`, `sort_by` (`LAST_MODIFIED`/`CREATED`) and returns `paging.next_start`. Needs `r_organization_social`. |

Both are annotated read-only. The server starts even with incomplete configuration; the tools then return a
`ConfigurationError`. stdout is reserved for MCP; diagnostics go to stderr, redacted.

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
| `client.getOrganization(id)` | `GET /rest/organizations/{id}` |
| `client.listPosts(authorUrn, { start?, count?, sortBy? })` | `GET /rest/posts?q=author&author=…` (finder) |
| `client.initializeImageUpload(orgUrn)` | `POST /rest/images?action=initializeUpload`. Returns `{ uploadUrl, image, uploadUrlExpiresAt }`. |
| `client.uploadImage(upload, bytes)` | `PUT` of a PNG or JPEG to the upload URL. The bearer token is sent only to `https://*.linkedin.com`. |
| `client.createPost(payload)` | `POST /rest/posts` with a complete, already formatted payload (validated by `postPayload`). Returns `{ id }` from `x-restli-id`. |
| `client.createArticlePost({ author, text, article })` | Link post. LinkedIn doesn't scrape URLs, so `title` (and optional `description`, `thumbnail` image URN) are given. `source` must be https. |
| `client.createImagePost({ author, text, image, altText? })` | Single-image post. |

**Text**

| Export | Purpose |
| ------ | ------- |
| `formatCommentary(text)` | Plain text → LinkedIn "little" text: escapes the 15 reserved characters `\ \| { } @ [ ] ( ) < > # * _ ~`, keeps `#word` hashtags, limit 3000 characters. |
| `plainText(commentary)` | The reverse, for matching a post that LinkedIn returns. |

Writes are **never retried** by the client.

### Errors

Every error is a `LinkedInError` with an `outcome`:

| Class | When | `outcome` |
| ----- | ---- | --------- |
| `ConfigError` | invalid configuration or input, refused before sending | `not_sent` |
| `AuthError` | not signed in, expired without refresh, missing scope (`not_sent`); HTTP 401 or a refused token request (`rejected`). `reauthorize` says whether to run `npm run auth` | `not_sent` / `rejected` |
| `ApiRefusalError` | HTTP 4xx other than 401/429, e.g. 403 `ACCESS_DENIED`, 422 duplicate. `status`, `serviceErrorCode`, `code` | `rejected` |
| `RateLimitError` | HTTP 429. Daily limits reset at midnight UTC. `retryAfterSeconds` is set only if LinkedIn sends `Retry-After` | `rejected` |
| `ServerError` | HTTP 5xx | `unknown` |
| `NetworkError` | no answer: connection failure, timeout | `unknown` |
| `InvalidResponseError` | 2xx that breaks the contract: invalid JSON, post created without an `x-restli-id` | `unknown` |

What each `outcome` means:
- `rejected`: nothing was created.
- `unknown`: the post may exist. Look for it with `listPosts` before trying again.

Messages are redacted when the error is created: registered tokens, codes and the client secret, `access_token=`,
`code=` and `state=` parameters, `Bearer …`, and JSON token fields.

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
   An `AuthError` here means nothing was attempted.
2. Bind the approval hash to the LinkedIn text, its language and `organizationUrn(config.organizationId)`.
3. Choose the post form:
   - Article post: `initializeImageUpload` → `uploadImage(PNG)` → `createArticlePost` with
     `{ source: <live article URL>, title, description, thumbnail: image }`.
   - Image post: `createImagePost`.
4. Before the create call, set `linkedin.status = "pending"` in `state.json`. On `outcome === "unknown"`, set it to
   `"unknown"`. The next attempt first calls `listPosts(orgUrn, { count: 25 })` and matches
   `plainText(post.commentary)` against the sent text (and `article_source` against the link) before posting again.
5. Record `{ id }` (the `urn:li:share:…` / `urn:li:ugcPost:…`) and log the event in `publications.jsonl`.

**Stable surface:** the exports listed above, the error classes and `outcome` values, and the `PostSummary` and
`PostList` shapes. The API version is the host's choice. Move forward before LinkedIn sunsets it, after re-running the
tests.

## Blocked until the Community Management API is approved

The app's *Community Management API* product is **pending**. Until LinkedIn approves it, the authorization screen won't
grant these scopes, and the calls fail with `AuthError` (`not_sent`, missing scope) or HTTP 403 `ACCESS_DENIED`:

| Capability | Scope | Blocked |
| ---------- | ----- | ------- |
| Organization lookup (`linkedin_get_organization`, `getOrganization`) | `rw_organization_admin` | yes |
| Listing the page's posts (`linkedin_list_posts`, `listPosts`), so also duplicate recovery after an unknown outcome | `r_organization_social` | yes |
| Image upload for the organization (`initializeImageUpload`, `uploadImage`) | `w_organization_social` | yes |
| Creating posts as the organization (`createPost`, `createArticlePost`, `createImagePost`) | `w_organization_social` | yes |
| Refresh tokens | enabled per app by LinkedIn (MDP partners) | likely; re-run `npm run auth` every < 60 days until then |
| Signing in (`npm run auth`), token storage, status | (none beyond the app itself) | no, but the granted scopes will lack the three above |

Not verified against a live response yet, because of the pending approval:
- the exact `PUT` upload response;
- how `{hashtag|\#|word}` renders;
- the 3000-character limit. The API docs only name `FIELD_LENGTH_TOO_LONG`, without a number.

Check these with a dry run and the first real post, approved by the owner.

## Security

- Tokens, the client secret and authorization codes are never logged or returned. All output passes through
  `sanitize.ts`.
- The token file must be an absolute path outside this repository. It is written atomically.
- The OAuth `state` is 32 random bytes, compared in constant time. The listener binds to the loopback host only.
- The bearer token is sent only to `https://api.linkedin.com` and to `https` upload URLs on `linkedin.com`. Redirects
  are not followed.
- No publishing MCP tool exists; the client never retries writes.
