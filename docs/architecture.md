# Architecture

Read-only knowledge — how the moving parts fit together. No commands here.
For "do this" recipes, see [`use-cases.md`](use-cases.md) and the
[patterns catalogue](../CLAUDE.md#adding-a-feature-pattern-catalogue).

## Request path

```
                    ┌──────────────────────────────┐
   Browser ───────▶ │   CloudFront                 │
                    │   /api/*           → APIGW   │ ──▶ Lambda (Hono)
                    │   /mcp             → APIGW   │       │
                    │   /oauth/*         → APIGW   │       │
                    │   /.well-known/*   → APIGW   │       │
                    │   /*               → S3      │       │
                    └──────────────────────────────┘       │
                                                           ├─▶ DynamoDB           ← all auth + app state in minimal template
                                                           │       • sessions / users / roles / OTP   (aws/cognito)
                                                           │       • registrations / oauth state       (aws-ddb-app-state)
                                                           ├─▶ Postmark           ← transactional email (OTP)
                                                           │
                                                           ├─▶ Aurora (Data API)  ← OPTIONAL — only when a pattern uses it
                                                           └─▶ S3 + presigned URL ← OPTIONAL — only when a pattern uses it
```

Four CloudFront behaviors route to the Lambda. `/api/*` is the normal
app surface; `/mcp`, `/oauth/*`, and `/.well-known/*` carry the MCP
integration. See [`docs/mcp.md`](mcp.md) for what each one serves.

- One CloudFront distribution serves both the static frontend and the
  API. **Same origin → no CORS** on backend calls.
- Static assets are versioned by Astro's build hash; CloudFront cache
  invalidation is handled by the deploy package's `BucketDeployment`.
- The Lambda is a single Hono handler that mounts every route under
  `/api/*`. It cold-starts on idle; warm requests are sub-50 ms.

## Data layer rule of thumb

The minimal template puts **everything in DynamoDB**: identity,
sessions, RBAC, public registrations, OAuth/MCP state. DDB is hot the
moment the Lambda warm-starts — no resume tax on user-facing paths.

Aurora is in `hereya.yaml` but unused by the minimal template. Patterns
that opt in (notes, posts, anything with joins or real relational
structure) re-introduce Drizzle + `db/` + migrations. Aurora's auto-
pause means the first hit after idle waits ~5s; that's an OK price for
relational app data, not OK for the public-form path.

When in doubt: simple key/value or schema-less data → DDB. Relational
structure that benefits from SQL → Aurora via the [notes pattern](patterns/notes.md).

## Pre-provisioned packages

Declared in `hereya.yaml`. All of these exist in the workspace whether
your app calls them or not.

| Package | Stage | What it puts in the Lambda env / IAM |
|---|---|---|
| `aws/cognito` | provision | `userPoolId`, `userPoolClientId`, `awsCognitoRegion`, `sessionsTableName`, `authUsersTableName`, `authRolesTableName`, `otpTableName`, IAM for Cognito + DDB auth tables |
| `hereya/aws-ddb-app-state` | provision | `registrationsTableName`, `oauthStateTableName`, IAM for the two app-state DDB tables |
| `hereya/postmark-app-server` | provision | `postmarkServerToken`, `postmarkFromEmail` |
| `hereya/aws-postgres-serverless` | provision | `clusterArn`, `secretArn`, `databaseName`, IAM for Data API — UNUSED by minimal template; consumed by patterns |
| `hereya/aws-file-storage` | provision | `bucketName`, `s3Prefix`, prefix-scoped S3 IAM — UNUSED by minimal template; consumed by patterns |
| `hereya/dev-iam-user` | devDeploy | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` for local dev |
| `hereya/aws-app-lambda` | deploy | `cloudfrontUrl`, `appUrl`, `apiUrl` |

## Workspace-level prerequisites

Provided by the workspace itself, NOT this template:

- **`bucketArn` / `bucketName`** — a workspace-installed
  `hereya/aws-s3-shared` creates the shared bucket. `aws-file-storage`
  consumes it and scopes IAM to a per-app prefix.
- **`defaultRootDomain`** (optional) — Route 53 hosted zone owned by the
  workspace. When set, the postmark and aws-app-lambda packages flip
  into auto-Route 53 mode. See [`custom-domain.md`](custom-domain.md).

If you ever need to know whether a workspace-level value is present, ask
the user — don't try to discover it from inside the project.

## Env-var flow

```
hereya/package CFn output:           registrationsTableName = MinimalApp-…
        │
        ▼
workspace env (managed by Hereya)
        │
        ▼
deploy (aws-app-lambda):             Lambda environment variables
devDeploy (dev-iam-user):            dev shell env (via AWS profile + creds)
        │
        ▼
process.env.registrationsTableName   read by apps/backend/src/auth/registrationsStore.ts
```

Special prefixes:

- **`iamPolicy*`** — values that match this prefix are treated as JSON
  IAM policies and **auto-attached** to the Lambda execution role
  (deploy) and the dev IAM user (devDeploy). They never become regular
  env vars at runtime. Examples: `iamPolicyForCognito`,
  `iamPolicyForAppState`, `iamPolicyAwsS3Bucket`.
- **`secret://…`** — values prefixed with this scheme are pulled by
  `aws-app-lambda` into a consolidated Secrets Manager secret. At
  runtime, the Lambda fetches and replaces them transparently — code
  just reads `process.env.<name>`. Use this for API keys (Stripe, etc.).

## Auth architecture

- **Sessions** — every successful OTP verification writes a row to
  DynamoDB (`sessionsTableName`) and sets a `hereya_sid` cookie (30-day
  TTL). Every authed request reads the session row to look up the user.
  The session row is the source of truth for "who is this request" —
  not the Cognito ID token.
- **RBAC** — two DDB tables: `users` (`userId`, `email`, `roleName`,
  `suspended`, `cognitoSub`) and `roles` (`roleName`, `permissions`).
  Permissions are **code constants** in `apps/backend/src/auth/permissions.ts`;
  the DDB rows hold which permissions each role currently grants. The
  default seed (`admin` = all permissions) is upserted on Lambda cold
  start in `seedRoles.ts`.
- **First-user bootstrap** — DDB sentinel `__bootstrap__` +
  `TransactWriteItems` with `attribute_not_exists` makes the first
  successful sign-in idempotent and exactly-once: that user becomes
  `admin`, everyone after that has to be added via `/admin/users`.
- **Suspend semantics** — flipping `users.suspended = true` also calls
  `deleteUserSessions(userId)` so suspension takes effect on the next
  request, not whenever the cache expires.
- **Client-side auth cache** — `lib/authState.ts` mirrors the server
  verdict in `localStorage` with a `sessionExpiresAt` timestamp from
  `/api/auth/me`. The /admin/* layout (`AdminBase.astro`) reads it
  synchronously in an inline `<head>` script and redirects pre-paint
  to `/login` if the cached verdict is missing / expired / anon — so
  the admin chrome never flashes for unauthenticated visitors.
- **Cross-tab sync** — `AuthNav` listens on `window`'s `storage` event
  for the key `hereya_auth_sync_v1`. Login + logout bump that key in
  `localStorage`, firing the event in sibling tabs (not the writing
  tab). Each sibling drops its cached verdict and re-fetches `/me`.

## OAuth / MCP state

All four entity kinds live in a single DDB table
(`OAuthStateTable`, provisioned by `aws-ddb-app-state`):

- `CLIENT#<clientId>` — DCR-registered MCP clients
- `CODE#<authCode>` — 60s auth codes, single-use
- `TOKEN#<accessTokenHash>` — full token row (refresh hash, userId,
  scope, expiries, revokedAt)
- `REFRESH#<refreshTokenHash>` — pointer to the canonical TOKEN# row

DDB native TTL on the `ttl` attribute prunes expired rows; validity
windows (60s codes, 24h access, 30d refresh) are also filtered at read
time. A sparse `byUser-index` GSI drives `/admin/integrations` —
only TOKEN# items set `userId`/`createdAt`, so the index returns just
the user's active connections.

## Frontend architecture

- **Static + islands**: Astro pre-renders all `.astro` pages at build
  time. Interactive bits are `<hy-*>` Lit custom elements registered
  via `client:only="lit"` (never `client:load` — see troubleshooting).
- **Light DOM** on every Lit element (`createRenderRoot() { return this; }`)
  so document-level Tailwind utility classes apply.
- **Loading skeletons** are composed from primitives in
  `apps/frontend/src/lib/skeleton.ts`. The shared
  `DeferredLoadingController` defers the skeleton by 200 ms (so fast
  loads never show one) and holds it for a minimum of 300 ms once shown
  (so slow loads don't flicker). Don't reinvent.
- **/admin/* gate**: `layouts/AdminBase.astro` injects an inline
  `<head>` script that reads `localStorage` synchronously and
  redirects to `/login` pre-paint for anon / expired visitors. The
  script's job is to never let the static admin scaffold paint for
  someone who shouldn't see it.

## Critical files you'll edit most

| Concern | File |
|---|---|
| Add or change a route | `apps/backend/src/routes/*.ts` + register in `app.ts` |
| Add an admin feature | both `apps/backend/src/routes/admin.ts` AND `apps/backend/src/mcp/tools/<name>.ts` (lockstep) |
| New permission | `apps/backend/src/auth/permissions.ts` + role defaults |
| Add a page | `apps/frontend/src/pages/*.astro` |
| Add an island | `apps/frontend/src/components/*.ts` + reference in a page |
| Change layout / nav | `apps/frontend/src/layouts/Base.astro` |
| Custom domain | `hereyaconfig/hereyavars/hereya--aws-app-lambda.yaml`, `hereyaconfig/hereyavars/hereya--postmark-app-server.yaml` |
| Tailwind tokens / classes | `apps/frontend/src/styles/global.css` |
