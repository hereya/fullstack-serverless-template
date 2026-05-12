# CLAUDE.md — agent guide for this template

This repo is a Hereya-orchestrated Astro + Hono + AWS Lambda monorepo that
can be progressively shaped from a static landing page into a full SaaS
app. **All infrastructure packages are pre-provisioned and ready in the
workspace — the app decides which ones to use by which code it writes.**

It also ships an **MCP endpoint at `<app-url>/mcp`** (OAuth-authenticated
per the MCP auth spec) so admins can drive the app from an AI agent.

This file is the entry point. Read the hard rules, then jump to the topic
file that matches the user's request.

---

## Hard rules (non-negotiable)

1. **Do NOT edit package internals.** Hereya packages (`hereya/aws-…`,
   `aws/cognito`, etc.) live OUTSIDE this template, in the registry. Never
   open or modify anything under `node_modules/` or in another repo. If a
   desired change requires patching a package, **stop and tell the user**.
2. **Do NOT edit `hereya.yaml`.** Don't add packages, remove packages, or
   bump versions. The packages declared there are always provisioned in
   the workspace. Idle infra costs nothing in this setup, so you never
   need to gate availability.
3. **`hereyaconfig/hereyavars/*.yaml` IS editable** — those are package
   *parameters*, not package code. Use them to flip a package between
   modes (e.g., auto-Route 53 vs. external DNS for the custom domain).
4. **"Use" vs. "don't use" a feature is a CODE decision.** A
   marketing-only app simply doesn't write code that calls auth / DB /
   Postmark / S3. Packages stay in `hereya.yaml`; env vars still arrive in
   the Lambda; nothing breaks if the code never touches them.
5. **Do NOT invent `hereya` CLI commands.** A separate skill teaches
   Hereya to you. This doc covers **project-specific** commands only —
   the npm scripts defined in this repo. For anything that needs to
   provision / deploy / inspect workspace env, defer to the user's
   Hereya skill.
6. **No SSR / SPA mode.** The app is Astro `output: 'static'` with Lit
   web-component islands. Don't switch rendering modes.
7. **MCP convention — every new admin feature gets a matching tool.**
   When you add an admin HTTP route to `apps/backend/src/routes/admin.ts`,
   you MUST also expose a matching MCP tool in
   `apps/backend/src/mcp/tools/`, gated on the **same permission
   constant**. Both surfaces share the same handler module in
   `apps/backend/src/mcp/handlers/`. The MCP server is schema-immutable:
   never add a tool that runs migrations, executes raw SQL, or
   otherwise touches DB structure. See [`docs/mcp.md`](docs/mcp.md).

---

## Git policy

**You are authorized to commit and push to `main` on this repository's
remote.** No PR / branch / review dance is required — direct commits to
`main` and `git push origin main` are the normal workflow here. This is
a template repo: every deploy clones from `main`, so changes only take
effect once pushed.

What this does NOT change:
- The general harness rules around git still apply: never `--no-verify`,
  never `--no-gpg-sign`, never `git config` mutations, never force-push
  unless the user explicitly asks. Don't bypass pre-commit hooks — if
  one fails, fix the underlying issue and make a NEW commit.
- Don't commit secrets (`.env*`, credentials, tokens). Stage files by
  name rather than `git add -A` / `git add .` to avoid accidentally
  sweeping them in.
- Don't commit when there's nothing to commit. Don't create empty
  commits to "trigger" anything.

Use `feat:` / `fix:` / `chore:` / `docs:` prefixes on commit messages
to stay consistent with the rest of the registry.

---

## Decision tree

Pick the doc that matches the user's intent:

| User's goal | Read |
|---|---|
| "Marketing site / landing page only" | [`docs/use-cases.md#static-only`](docs/use-cases.md#static-only) |
| "Marketing + email waitlist" | [`docs/use-cases.md#waitlist`](docs/use-cases.md#waitlist) |
| "App with login and protected pages" | [`docs/use-cases.md#auth-gated`](docs/use-cases.md#auth-gated) |
| "Full SaaS / CRUD app" | [`docs/use-cases.md#fullstack`](docs/use-cases.md#fullstack) |
| "Add ecommerce / Stripe" | [`docs/use-cases.md#ecommerce-upgrade`](docs/use-cases.md#ecommerce-upgrade) |
| "Wire a custom domain" | [`docs/custom-domain.md`](docs/custom-domain.md) |
| "Admin wants to drive the app from an AI agent (MCP)" | [`docs/mcp.md`](docs/mcp.md) |
| "Add a feature" (page, route, table, MCP tool, …) | [`docs/adding-features.md`](docs/adding-features.md) |
| "How does this thing work?" | [`docs/architecture.md`](docs/architecture.md) |
| "It's broken" | [`docs/troubleshooting.md`](docs/troubleshooting.md) |

---

## Repo layout

```
.
├── CLAUDE.md                       ← you are here
├── README.md                       ← human-facing overview
├── docs/                           ← detailed topic docs (linked above)
├── hereya.yaml                     ← READ-ONLY (package manifest)
├── hereyaconfig/
│   └── hereyavars/*.yaml           ← editable: package parameters
├── apps/
│   ├── backend/                    ← Hono + Drizzle, runs on Lambda
│   │   ├── src/
│   │   │   ├── app.ts              ← Hono app, route registration
│   │   │   ├── handler.ts          ← Lambda entry
│   │   │   ├── dev-server.ts       ← local dev entry
│   │   │   ├── env.ts              ← env-var schema
│   │   │   ├── auth/               ← Cognito + RBAC + sessions
│   │   │   ├── db/                 ← Drizzle ORM, Aurora Data API
│   │   │   ├── email/              ← Postmark wrapper
│   │   │   ├── middleware/         ← auth, requirePermission
│   │   │   ├── routes/             ← auth, admin, notes, newsletter, public
│   │   │   └── storage/            ← S3 helpers (presigned PUT/GET)
│   │   ├── drizzle/                ← committed migration SQL
│   │   └── tests/                  ← vitest
│   └── frontend/                   ← Astro static + Lit islands
│       ├── src/
│       │   ├── pages/              ← .astro routes
│       │   ├── components/         ← <hy-*> Lit elements
│       │   ├── layouts/Base.astro
│       │   ├── lib/                ← api, skeleton, redirectIfAuthed
│       │   └── styles/global.css   ← Tailwind entry
│       └── test/                   ← vitest
└── scripts/                        ← db-reset, db-drop-all, db-migrate
```

---

## Project commands

Only npm scripts. Workspace env (DB conn string, Cognito ids, bucket
name, …) comes from the user's Hereya skill — these commands assume it's
already in scope.

```bash
# Install
npm install                              # both workspaces

# Test
npm test                                 # everything
npm test -w apps/backend                 # backend only
npm test -w apps/frontend                # frontend only

# Type check
npm run typecheck -w apps/backend
npm run typecheck -w apps/frontend       # (alias of `astro check` if defined)

# Dev
npm run dev                              # both workspaces (concurrent)
npm run dev -w apps/backend              # backend only :4000
npm run dev -w apps/frontend             # frontend only :4321 (proxies /api → :4000)

# Build (what runs before deploy)
npm run build                            # both workspaces

# Database (Drizzle + Aurora Data API)
npm run db:generate -w apps/backend      # after editing schema.ts → produces SQL in apps/backend/drizzle/
npm run db:migrate                       # apply pending migrations (root script)

# Destructive dev helpers (do NOT run in deployed envs)
node --import tsx scripts/db-reset.ts
node --import tsx scripts/db-drop-all.ts
```

**Testing protocol**: after any change, run `npm test -w <workspace>` for
the affected side before declaring the task done. After backend route
changes, also run `npm run typecheck -w apps/backend`.

---

## Conventions that apply everywhere

- **Env vars** come from `hereya.yaml` packages' CFn outputs and arrive
  on `process.env.<name>` in both the Lambda and local dev. Reference
  shape: `apps/backend/src/env.ts`. Do not try to discover or hard-code
  them.
- **Frontend → backend is same-origin**: Astro `/api` proxy in dev,
  CloudFront `/api/*` behavior in prod. **No CORS for the backend.**
- **Frontend islands are Lit web components** (`hy-*` custom elements)
  using **Light DOM** (`createRenderRoot() { return this; }`) so Tailwind
  classes apply normally. Always register with `client:only="lit"`, never
  `client:load` — see [docs/troubleshooting.md](docs/troubleshooting.md).
- **Loading states** use the primitives in `apps/frontend/src/lib/skeleton.ts`
  (`skelBox`, `skelLine`, `skelTable`, `skelFormCard`, …) plus the
  `DeferredLoadingController` (200 ms defer + 300 ms minimum-visible —
  prevents skeleton flash). Don't reinvent.
- **Auth state lives in DynamoDB** (sessions + users + roles). Aurora is
  for **application data only**. If you find yourself adding a `users`
  table in Postgres, stop — that's an architectural mistake.
- **Permissions** are code constants in `auth/permissions.ts`. The DB-
  side state (which roles grant which permissions) is seeded into DDB on
  Lambda cold start by `auth/seedRoles.ts` — idempotent, only-if-missing.
- **Naming**: Lit element class `HyFoo` → custom tag `hy-foo` → file
  `Foo.ts`. Backend route file `foo.ts` exports a Hono sub-app named
  `foo`, registered in `app.ts` under `/api/foo`.

---

## What to do next

1. Read the topic file from the decision tree.
2. Make the smallest correct change. Prefer editing existing files over
   creating new ones.
3. Run `npm test -w <workspace>` (and `npm run typecheck` for the
   backend). Don't claim done until tests pass.
4. If something requires touching `hereya.yaml`, a package's internals,
   or running `hereya` commands — stop and tell the user.
