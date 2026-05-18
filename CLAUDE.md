# CLAUDE.md — agent guide for this template

This repo is a Hereya-orchestrated Astro + Hono + AWS Lambda monorepo.
**The minimal template ships four things**: a static landing, a public
registration form, an admin page, and an MCP server. Everything beyond
that is a **pattern** the agent applies on demand — see the catalogue
below.

It also ships an **MCP endpoint at `<app-url>/mcp`** (OAuth-authenticated
per the MCP auth spec) so admins can drive the app from an AI agent.

This file is the entry point. Read the hard rules, then jump to the
pattern doc that matches the user's request.

---

## Hard rules (non-negotiable)

1. **Do NOT edit package internals.** Hereya packages (`hereya/aws-…`,
   `aws/cognito`, etc.) live OUTSIDE this template, in the registry.
   Never open or modify anything under `node_modules/` or in another
   repo. If a desired change requires patching a package, **stop and
   tell the user**.
2. **`hereya.yaml` adds new packages only when a pattern requires it.**
   Patterns that need infra (e.g. notes → Aurora) DO add their package
   to `hereya.yaml` — that's expected and called out in each pattern
   doc. Don't *remove* a package; idle infra costs nothing in this setup.
3. **`hereyaconfig/hereyavars/*.yaml` IS editable** — those are package
   *parameters*, not package code. Use them to flip a package between
   modes (e.g. auto-Route 53 vs. external DNS for the custom domain).
4. **"Use" vs. "don't use" a feature is a CODE decision.** A
   marketing-only app simply doesn't write code that calls the
   pattern-specific helpers. Packages stay in `hereya.yaml`; env vars
   still arrive in the Lambda; nothing breaks if the code never touches
   them.
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
8. **Data layer rule of thumb.** Simple key/value or schema-less data
   (registrations, feature flags, OAuth state, anything "I just need
   a row I can look up by id") → DynamoDB (provisioned by
   `aws/cognito` for auth and by `hereya/aws-ddb-app-state` for app
   state). Relational app data with real structure (notes, posts,
   joins, transactions) → Aurora Postgres + Drizzle, via the
   [notes pattern](docs/patterns/notes.md). Aurora auto-pauses when
   idle so user-facing paths that hit it pay a cold-start tax — only
   use it when the relational model is worth the latency.
   **User-supplied secrets** (admin API keys, per-user OAuth tokens,
   webhook signing secrets — anything where a user sets a value that
   must be encrypted at rest and write-only from their perspective) →
   the vault via `hereya/aws-secret-vault`, see the
   [user-secrets pattern](docs/patterns/user-secrets.md). Do NOT
   store sensitive values directly in the plain DDB or Aurora tables.

---

## Adding a feature (pattern catalogue)

Common features beyond the minimal template surface live as **patterns** —
self-contained step-by-step docs. Read the relevant one and apply it
verbatim. Each pattern is designed to be runnable by a future agent
without back-references to prior context.

| Pattern | Use when |
|---|---|
| [notes / CRUD app data](docs/patterns/notes.md) | The user wants a feature with real relational structure: posts, todos, a knowledge base, anything with joins. Adds Drizzle + Aurora. |
| [file attachments](docs/patterns/attachments.md) | A feature needs user-uploaded files (images, PDFs). Uses the S3 package already in `hereya.yaml`. |
| [richer registration form](docs/patterns/richer-registration.md) | The default email-only registration form needs name / company / event-specific fields. |
| [one-shot data migrations](docs/patterns/migrations.md) | Need to backfill, transform, or move data between stores (Aurora→DDB, schema evolution within DDB). Wires the existing no-op `migrate.ts` Lambda to a list of idempotent migrations gated by a DDB sentinel. |
| [newsletter signup](docs/patterns/newsletter.md) | Public "drop your email here" form that lands in Aurora, plus an admin list at `/api/admin/subscriptions`. Use when you want joinable subscriber history; skip if a Postmark broadcast list is enough. |
| [OG / share-preview images](docs/patterns/og-image.md) | Customize the link-preview card that appears when the site is shared on Slack, Discord, X, LinkedIn, WhatsApp, etc. Edit `scripts/og-card.html`, regenerate `og-image.png` via Chrome headless. |
| [user-supplied secrets](docs/patterns/user-secrets.md) | A feature needs to store user-supplied secrets — admin integration keys (Stripe, Slack, etc.), per-user OAuth tokens, webhook signing secrets. KMS-encrypted at rest. Write-only-from-user-perspective: plaintext can be set/rotated but never read back through HTTP routes or MCP tools — only server-side code decrypts. Adds `hereya/aws-secret-vault` (already in `hereya.yaml`). |

If you need a pattern that's not listed, build it; when it works, write
the pattern doc and add it to this table.

---

## Post-deploy onboarding

When the user says "help me get set up" (or similar) right after a
fresh `hereya deploy`, read [`docs/getting-started.md`](docs/getting-started.md)
and walk them through it:

1. Open the deployed app URL → click Login → request OTP for their email.
2. First sign-in becomes admin automatically (the `createFirstAdmin`
   bootstrap in `apps/backend/src/auth/users.ts`).
3. Connect Claude Desktop (or another MCP client) to `<app-url>/mcp`.
4. Verify with a tool call: ask Claude to "list users".

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
- Don't commit when there's nothing to commit.

Use `feat:` / `fix:` / `chore:` / `docs:` prefixes on commit messages
to stay consistent with the rest of the registry.

---

## Repo layout

```
.
├── CLAUDE.md                       ← you are here
├── README.md                       ← human-facing overview
├── docs/
│   ├── getting-started.md          ← post-deploy walkthrough (you read this)
│   ├── architecture.md             ← system design overview
│   ├── mcp.md                      ← MCP integration details
│   ├── custom-domain.md            ← custom domain wiring
│   ├── troubleshooting.md          ← common issues
│   └── patterns/                   ← apply these on demand
│       ├── notes.md
│       ├── attachments.md
│       ├── richer-registration.md
│       ├── migrations.md
│       ├── newsletter.md
│       └── og-image.md
├── hereya.yaml                     ← package manifest (extend per pattern)
├── hereyaconfig/
│   └── hereyavars/*.yaml           ← editable: package parameters
├── apps/
│   ├── backend/                    ← Hono, runs on Lambda
│   │   ├── src/
│   │   │   ├── app.ts              ← Hono app, route registration
│   │   │   ├── handler.ts          ← Lambda entry
│   │   │   ├── dev-server.ts       ← local dev entry
│   │   │   ├── env.ts              ← env-var schema
│   │   │   ├── auth/               ← Cognito + RBAC + sessions + stores
│   │   │   │   ├── sessions.ts     ← DDB session reads/writes
│   │   │   │   ├── users.ts        ← DDB users + first-admin bootstrap
│   │   │   │   ├── roles.ts        ← DDB roles + permissions
│   │   │   │   ├── permissions.ts  ← permission constants + role cache
│   │   │   │   ├── seedRoles.ts    ← admin role seed on cold start
│   │   │   │   ├── registrationsStore.ts  ← DDB public registrations
│   │   │   │   └── oauthStore.ts          ← DDB OAuth/MCP state
│   │   │   ├── email/              ← Postmark wrapper
│   │   │   ├── middleware/         ← auth, requirePermission
│   │   │   └── routes/             ← auth, admin, registration, oauth, mcp, public
│   │   └── tests/                  ← vitest
│   └── frontend/                   ← Astro static + Lit islands
│       ├── src/
│       │   ├── pages/              ← .astro routes
│       │   ├── components/         ← <hy-*> Lit elements
│       │   ├── layouts/            ← Base.astro, AdminBase.astro
│       │   ├── lib/                ← api, skeleton, authState, redirectIfAuthed
│       │   └── styles/global.css   ← Tailwind entry
│       └── test/                   ← vitest
```

The minimal template has **no `db/` or `drizzle/`** in the backend.
Those reappear when the notes pattern is applied — see
[`docs/patterns/notes.md`](docs/patterns/notes.md).

---

## Project commands

Only npm scripts. Workspace env (DDB table names, Cognito ids, Postmark
token, …) comes from the user's Hereya skill — these commands assume
it's already in scope.

```bash
# Install
npm install                              # both workspaces

# Test
npm test                                 # everything
npm test -w apps/backend                 # backend only
npm test -w apps/frontend                # frontend only

# Type check
npm run typecheck -w apps/backend

# Dev
npm run dev                              # both workspaces (concurrent)
npm run dev -w apps/backend              # backend only :4000
npm run dev -w apps/frontend             # frontend only :4321 (proxies /api → :4000)

# Build (what runs before deploy)
npm run build                            # both workspaces
```

After applying the notes pattern, additional scripts come back:
`db:generate` (regenerate Drizzle SQL from `schema.ts`) and `db:migrate`
(apply pending migrations). See the pattern doc.

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
  plus the `DeferredLoadingController` (200 ms defer + 300 ms minimum-
  visible — prevents skeleton flash). Don't reinvent.
- **/admin/* gate.** All admin pages use `layouts/AdminBase.astro`
  which injects an inline `<head>` script that synchronously reads
  `localStorage` and redirects to `/login` BEFORE any body paint if the
  visitor isn't a cached admin user. See `lib/authState.ts` for the
  cache schema; do not bypass the gate from any new admin page.
- **Permissions** are code constants in `auth/permissions.ts`. The DDB-
  side state (which roles grant which permissions) is seeded into DDB on
  Lambda cold start by `auth/seedRoles.ts` — idempotent.
- **Naming**: Lit element class `HyFoo` → custom tag `hy-foo` → file
  `Foo.ts`. Backend route file `foo.ts` exports a Hono sub-app named
  `foo`, registered in `app.ts` under `/api/foo`.

---

## What to do next

1. If the user is just deployed → walk them through
   [`docs/getting-started.md`](docs/getting-started.md).
2. If the user wants a feature → check the **pattern catalogue** above.
   Apply the matching pattern verbatim. If nothing matches, build the
   feature and then write a new pattern doc.
3. Make the smallest correct change. Prefer editing existing files over
   creating new ones.
4. Run `npm test -w <workspace>` (and `npm run typecheck` for the
   backend). Don't claim done until tests pass.
5. If something requires patching a package's internals or running
   `hereya` commands the agent doesn't have a skill for — stop and tell
   the user.
