# Architecture

Read-only knowledge — how the moving parts fit together. No commands here.
For "do this" recipes, see [`use-cases.md`](use-cases.md) and
[`adding-features.md`](adding-features.md).

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
                                                           ├─▶ Aurora (Data API)  ← app data + oauth_*
                                                           ├─▶ DynamoDB           ← sessions + RBAC + OTP
                                                           ├─▶ Postmark           ← transactional email
                                                           └─▶ S3 + presigned URL ← attachments
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

## Pre-provisioned packages

Declared in `hereya.yaml` (read-only). All of these exist in the
workspace whether your app calls them or not — that's intentional.

| Package | Stage | What it puts in the Lambda env / IAM |
|---|---|---|
| `hereya/aws-postgres-serverless` | provision | `clusterArn`, `secretArn`, `databaseName`, IAM for Data API |
| `aws/cognito` | provision | `userPoolId`, `userPoolClientId`, `sessionsTableName`, `authUsersTableName`, `authRolesTableName`, `otpTableName`, IAM for Cognito + DDB |
| `hereya/postmark-app-server` | provision | `postmarkServerToken`, `postmarkFromEmail`, `effectiveDomain`, `effectiveSubdomain` |
| `hereya/aws-file-storage` | provision | `bucketName`, `s3Prefix`, prefix-scoped S3 IAM |
| `hereya/dev-iam-user` | devDeploy | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` for local dev |
| `hereya/aws-app-lambda` | deploy | `cloudfrontUrl`, `appUrl`, `apiUrl` |

## Workspace-level prerequisites

Provided by the workspace itself, NOT this template:

- **`bucketArn` / `bucketName`** — a workspace-installed
  `hereya/aws-s3-shared` creates the shared bucket. `aws-file-storage`
  consumes it and scopes IAM to a per-app prefix.
- **`defaultRootDomain`** (optional) — Route 53 hosted zone owned by the
  workspace. When set, the postmark and aws-app-lambda packages flip
  into auto-Route 53 mode (DKIM, return-path, ACM, ALIAS records all
  managed). See [`custom-domain.md`](custom-domain.md).

If you ever need to know whether a workspace-level value is present, ask
the user — don't try to discover it from inside the project.

## Env-var flow

```
hereya/package CFn output:           bucketName = platform-…
        │
        ▼
workspace env (managed by Hereya)
        │
        ▼
deploy (aws-app-lambda):             Lambda environment variables
devDeploy (dev-iam-user):            dev shell env (via AWS profile + creds)
        │
        ▼
process.env.bucketName               read by apps/backend/src/storage/s3.ts
```

Special prefixes:

- **`iamPolicy*`** — values that match this prefix are treated as JSON
  IAM policies and **auto-attached** to the Lambda execution role
  (deploy) and the dev IAM user (devDeploy). They never become regular
  env vars at runtime. Examples: `iamPolicyForCognito`,
  `iamPolicyAwsS3Bucket`, `iamPolicyAuthRbac`.
- **`secret://…`** — values prefixed with this scheme are pulled by
  `aws-app-lambda` into a consolidated Secrets Manager secret. At
  runtime, the Lambda fetches and replaces them transparently — code
  just reads `process.env.<name>`. Use this for API keys (Stripe, etc.).

## Auth architecture (one paragraph each)

- **Sessions** — every successful OTP verification writes a row to
  DynamoDB (`sessionsTableName`) and sets a `hereya_sid` cookie (7-day
  rolling). Every authed request reads the session row to look up the
  user. The session is the source of truth for "who is this request" —
  not the Cognito ID token.
- **RBAC** — two DDB tables: `users` (`userId`, `email`, `roleName`,
  `suspended`, `cognitoSub`) and `roles` (`roleName`, `permissions`).
  Permissions are **code constants** in `apps/backend/src/auth/permissions.ts`;
  the DDB rows hold which permissions each role currently grants, so an
  admin can mutate role definitions without a code change. The default
  seed (`admin` = all, `member` = notes:read+write) is upserted only-if-
  missing in `seedRoles.ts`, called from Lambda cold start.
- **First-user bootstrap** — DDB sentinel `__bootstrap__` + a
  `TransactWriteItems` with `attribute_not_exists` makes the first
  successful sign-in idempotent and exactly-once: that user becomes
  `admin`, everyone after that has to be added by an existing admin via
  `/admin/users`.
- **Suspend semantics** — flipping `users.suspended = true` also calls
  `deleteUserSessions(userId)` so the suspension takes effect on the
  next request, not whenever the cache expires.
- **Cross-tab sync** — `AuthNav` listens on `window`'s `storage` event
  for the key `hereya_auth_sync_v1`. Login + logout bump that key in
  `localStorage`, which fires the event in sibling tabs (it doesn't fire
  in the writing tab). Each sibling drops its 5-min `sessionStorage`
  cache and re-fetches `/api/auth/me`.

## Frontend architecture

- **Static + islands**: Astro pre-renders all `.astro` pages at build
  time. Interactive bits are `<hy-*>` Lit custom elements registered via
  `client:only="lit"` (never `client:load` — see troubleshooting).
- **Light DOM** on every Lit element (`createRenderRoot() { return this; }`)
  so document-level Tailwind utility classes apply. This is the
  Tailwind-vs-shadow-DOM workaround.
- **Loading skeletons** are composed from primitives in
  `apps/frontend/src/lib/skeleton.ts`. The shared `DeferredLoadingController`
  defers the skeleton by 200 ms (so fast loads never show one) and holds
  it for a minimum of 300 ms once shown (so slow loads don't flicker).
  Don't reinvent.

## Critical files you'll edit most

| Concern | File |
|---|---|
| Add or change a route | `apps/backend/src/routes/*.ts` + register in `app.ts` |
| Schema change | `apps/backend/src/db/schema.ts` (then `npm run db:generate`) |
| New permission | `apps/backend/src/auth/permissions.ts` + role defaults |
| Add a page | `apps/frontend/src/pages/*.astro` |
| Add an island | `apps/frontend/src/components/*.ts` + reference in a page |
| Change layout / nav | `apps/frontend/src/layouts/Base.astro` |
| Custom domain | `hereyaconfig/hereyavars/hereya--aws-app-lambda.yaml`, `hereyaconfig/hereyavars/hereya--postmark-app-server.yaml` |
| Tailwind tokens / classes | `apps/frontend/src/styles/global.css` |
