# Use cases

The minimal template covers four shapes out of the box:

1. **Static marketing site** — `pages/index.astro` + `pages/about.astro`.
   No code change needed; just edit the markup.
2. **Public registration / waitlist** — `pages/register.astro` already
   ships, posting to `/api/registration` → DDB. Edit the page copy to
   match the user's pitch.
3. **Admin app** — `pages/admin/users.astro`, `admin/registrations.astro`,
   `admin/integrations.astro`. First sign-in becomes admin
   automatically (the bootstrap in `apps/backend/src/auth/users.ts`).
4. **MCP-driven app** — `/mcp` endpoint with OAuth 2.1, exposing
   `users_*`, `registrations_*`, `roles_*`, `stats_*` tools. Connect
   from Claude Desktop per [`docs/getting-started.md`](getting-started.md).

Anything beyond these is a **pattern**. Pick from the catalogue:

| User's goal | Pattern |
|---|---|
| Notes, posts, todos, anything CRUD-relational | [`patterns/notes.md`](patterns/notes.md) |
| User-uploaded files | [`patterns/attachments.md`](patterns/attachments.md) |
| Extra fields on the registration form | [`patterns/richer-registration.md`](patterns/richer-registration.md) |

Patterns explicitly call out the infra they extend (Aurora, S3, etc.).
The packages are already in `hereya.yaml` — patterns are purely code +
config.

---

## What to swap when remixing the minimal template

For a **landing-page-only** project: keep `index.astro` + `about.astro`,
delete (or hide via nav) `/register` and the admin pages. The MCP server
keeps working — useful if the user wants to admin via Claude only.

For a **registration-funnel** project (event signup, waitlist): keep
everything; rewrite `index.astro` copy and `register.astro` to match.
Apply the richer-registration pattern if you need more than email +
name.

For a **full SaaS** project: start from the minimal template, apply
the notes pattern for your domain entity, then ship features by
copying the notes pattern as a template (it's the canonical reference).

For an **ecommerce / billing** project: no shipped pattern yet —
follow the notes pattern's shape and add a Stripe wrapper around it.
Worth contributing back as `patterns/stripe.md` once it works.
