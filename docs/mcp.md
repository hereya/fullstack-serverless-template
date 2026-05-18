# MCP integration

The template exposes an MCP server at **`<app-url>/mcp`**, authenticated
per the MCP authorization spec (OAuth 2.1 + PKCE + Dynamic Client
Registration). Admins connect Claude Desktop or any other MCP client
and drive their app from an AI agent — list users, add users, suspend,
inspect newsletter subscriptions, edit role permissions, view stats.

> **For coding agents extending this template**: when you add a new
> admin route, you MUST also expose a matching MCP tool. See
> [convention below](#convention-every-new-admin-feature-exposes-an-mcp-tool).

---

## Architecture

```
┌─────────────────────────┐                  ┌──────────────────────────────┐
│  MCP Client             │                  │ CloudFront                   │
│  (Claude Desktop, …)    │                  │ ├─ /api/*           → Lambda │
│                         │                  │ ├─ /mcp             → Lambda │
│  1. POST  /mcp          │ ───────────────▶ │ ├─ /oauth/*         → Lambda │
│     (401, redirect      │                  │ ├─ /.well-known/*   → Lambda │
│      to OAuth flow)     │                  │ └─ /*               → S3     │
│  2. browser → /oauth/   │                  └──────────────────────────────┘
│     authorize → consent │
│  3. POST  /oauth/token  │
│  4. POST  /mcp          │
│     Authorization:Bearer│
└─────────────────────────┘
```

URLs the spec touches (all routed to the Lambda by the
`hereya/aws-app-lambda` package's CloudFront behaviors):

| URL | Purpose |
|---|---|
| `/mcp` | MCP Streamable-HTTP endpoint (POST JSON-RPC) |
| `/.well-known/oauth-protected-resource` | RFC 9728 resource metadata — points clients at the OAuth server |
| `/oauth/.well-known/oauth-authorization-server` | RFC 8414 auth-server metadata |
| `/oauth/register` | RFC 7591 Dynamic Client Registration |
| `/oauth/authorize` | OAuth authorization endpoint (browser entry) |
| `/oauth/authorize/confirm` | Internal — frontend consent page POSTs here |
| `/oauth/token` | OAuth token endpoint (code exchange + refresh) |
| `/connect` | Frontend consent UI (the browser is redirected here by `/oauth/authorize`) |

State backed by three Postgres tables (Drizzle migrations, see
`apps/backend/src/db/schema.ts`):

- `oauth_clients` — DCR-registered apps (public clients only, no secret)
- `oauth_auth_codes` — short-lived authorization codes (~60 s TTL)
- `oauth_tokens` — access + refresh tokens, stored as SHA-256 hashes,
  soft-deleted via `revoked_at` for the admin revocation flow

---

## Permission model

MCP is **permission-gated, never role-gated.** Every tool checks a
specific permission via the existing `roleHasPermission()` helper. A
coarse `MCP_CONNECT` permission gates the OAuth consent step itself —
without it a user can't authorize an MCP client at all.

The admin role gets every permission via `ALL_PERMISSIONS`, so out of
the box "MCP is admin-only." But the model scales: granting a new
`ops` role `MCP_CONNECT + USERS_LIST + SUBSCRIPTIONS_LIST` lets that
role drive a read-only ops agent without becoming a full admin.

Current tool→permission mapping:

| Tool | Permission |
|---|---|
| `users_list` | `USERS_LIST` |
| `users_add` | `USERS_ADD` |
| `users_set_suspended` | `USERS_SUSPEND` |
| `subscriptions_list` | `NEWSLETTER_LIST` |
| `roles_list` | `ROLES_LIST` |
| `roles_update_permissions` | `ROLES_UPDATE` |
| `stats_summary` | `STATS_VIEW` |

Tool names use **underscores, not dots**. Some MCP hosts (notably the
Claude.ai web client) validate tool names against
`^[a-zA-Z0-9_-]{1,64}$` and reject dot-namespaced names like
`users.list`. Stick to `<resource>_<action>` and never reach 64 chars.

These mirror exactly the permissions used by the matching HTTP routes
in `apps/backend/src/routes/admin.ts`. Both surfaces share the
underlying handler (`apps/backend/src/mcp/handlers/*.ts`) and the same
permission constant, so the two can't drift.

---

## Hard rules (additive to CLAUDE.md)

1. **Schema is immutable from MCP.** No tool runs migrations, executes
   arbitrary SQL, alters tables, or creates new schema. Data mutations
   on existing tables are fine; structure changes are not. **Never
   add a tool that does any of these.** If a feature requires it, the
   user (not the MCP-connected agent) does it via `npm run db:generate`
   and a deploy.
2. **Never gate on role, always on permission.** No
   `roleName === 'admin'` checks in `mcp/tools/` or `mcp/handlers/`.
3. **One shared handler per resource.** The HTTP admin route and the
   MCP tool MUST call into the same `mcp/handlers/*.ts` function.

---

## Connecting from Claude Desktop

Per Claude Desktop's config file (typically
`~/Library/Application Support/Claude/claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "my-app": {
      "url": "https://your-app.example.com/mcp"
    }
  }
}
```

On first connect Claude Desktop:
1. Hits `/mcp` and gets a 401 + `WWW-Authenticate: Bearer resource_metadata=…`
2. Fetches `/.well-known/oauth-protected-resource` → discovers the OAuth server URL.
3. Fetches `/oauth/.well-known/oauth-authorization-server` → endpoint URLs.
4. Calls `POST /oauth/register` (DCR) → receives a `client_id`.
5. Opens `/oauth/authorize?…` in your default browser.
6. You log in (if not already), land on `/connect` consent page, click **Approve**.
7. Browser redirects back to Claude Desktop's loopback callback with `code=…`.
8. Claude Desktop calls `POST /oauth/token` → access + refresh tokens.
9. Subsequent `/mcp` calls succeed with the bearer token.

The access token lives for **24 hours**; the refresh token for **30 days**.
Refresh rotates: every refresh exchange invalidates the old refresh
token. Revoke from `/admin/integrations` to kill a token immediately.

---

## Convention: every new admin feature exposes an MCP tool

When you add a new admin HTTP route to
`apps/backend/src/routes/admin.ts`:

1. Extract the handler into `apps/backend/src/mcp/handlers/<resource>.ts`
   as a function taking `(input)` and returning a serializable value.
   Throw typed `Error` subclasses for known failure cases (e.g.
   `NotFoundError`, `ValidationError`) — the HTTP route and the tool
   each map these to surface-appropriate errors.
2. Add `requirePermission(PERMISSIONS.SOMETHING_NEW)` to the HTTP route.
3. Add a matching tool in `apps/backend/src/mcp/tools/<resource>.ts`:

   ```ts
   server.registerTool(
     'something.new',
     {
       description: 'What the tool does.',
       inputSchema: { /* zod fields */ },
     },
     async (input, extra) =>
       withPermission(extra, PERMISSIONS.SOMETHING_NEW, async () => {
         const result = await somethingNewHandler(input);
         return ok({ result }, `Did something.`);
       }),
   );
   ```

4. Register the tool group in `apps/backend/src/mcp/server.ts` if it's
   a new resource (existing `users/roles/subscriptions/stats` already
   wired).
5. Add tests in `apps/backend/tests/mcp.test.ts`.

Reference: `users_set_suspended` end-to-end — same permission
(`USERS_SUSPEND`) on both surfaces, same handler, same last-admin
safeguard. Copy that shape.

---

## Adding a new permission

For tools without an HTTP-side equivalent (e.g. `STATS_VIEW`):

1. Edit `apps/backend/src/auth/permissions.ts`:
   ```ts
   export const PERMISSIONS = {
     …,
     STATS_VIEW: 'stats:view',
   };
   ```
2. The permission lands in `ALL_PERMISSIONS` automatically (it's
   `Object.values(PERMISSIONS)`) — admins keep the full surface.
3. To grant the permission to a non-admin role too, update
   `MEMBER_PERMISSIONS` or call `roles_update_permissions` from MCP.

`seedRoles.ts` upserts only-if-missing, so existing DDB role rows are
not overwritten on the next cold start — defaults apply only to fresh
roles.

---

## Revoking a connection

From `/admin/integrations`, click **Revoke** on the row for a client.

What happens server-side:

- `DELETE /api/admin/integrations/:tokenId` stamps `revoked_at` on the
  `oauth_tokens` row.
- `apps/backend/src/auth/mcpAuth.ts` filters on `revoked_at IS NULL` on
  every `/mcp` request — the next call from the revoked client returns
  401 with the WWW-Authenticate header pointing at the resource metadata.
- The MCP client typically reacts to 401 by re-running the OAuth flow.
  Until the user explicitly approves again at `/connect`, the client
  is locked out.

The row is soft-deleted (not hard-deleted) so the audit trail survives.

---

## Testing

`apps/backend/tests/oauth.test.ts` covers:
- DCR happy path
- `/oauth/authorize` redirects unauthed visitors to `/login?next=…`
- `/oauth/authorize` rejects users without `MCP_CONNECT`
- Code exchange happy path (with valid PKCE verifier)
- Code exchange fails on wrong PKCE verifier
- Code exchange fails on expired / consumed code
- Refresh token rotation

`apps/backend/tests/mcp.test.ts` covers:
- Bearer-token middleware rejects unauthed
- A user with `MCP_CONNECT` but lacking `USERS_LIST` gets a tool error
- A user with the required permission gets the expected tool shape
- `users_set_suspended` invokes the same handler as the HTTP route
  (last-admin safeguard fires from both surfaces)
- Revoked token → 401

Run with `npm test -w apps/backend`.

---

## Local development

The OAuth flow involves browser redirects, so you need a fully
working frontend + backend dev server. Standard `npm run dev` handles
this — the Astro proxy at `/api`, `/oauth`, `/mcp`, `/.well-known`
forwards to the Hono backend on `:4000`.

(Configured automatically when you started the dev server — see
`apps/frontend/astro.config.mjs`. If you added the routes ad-hoc, add
proxy entries for `/oauth`, `/mcp`, and `/.well-known` to that file —
each must include `xfwd: true` so the backend learns the public host.)

For MCP-client integration testing locally, your MCP client connects
to `http://localhost:4321/mcp` and the OAuth flow round-trips through
the Astro dev server.

**How discovery URLs are derived.** The `resource` field in
`/.well-known/oauth-protected-resource` (and the `WWW-Authenticate`
header on a 401 from `/mcp`) must match the URL the MCP client used,
or the client rejects the resource as mismatched. The backend picks
the URL like so:

1. **Production**: `process.env.appUrl` is set by
   `hereya/aws-app-lambda` and is the canonical public URL. Used
   unconditionally. CloudFront strips `Host` and any client-supplied
   `X-Forwarded-Host` via the `ALL_VIEWER_EXCEPT_HOST_HEADER` origin
   request policy, so trusting forwarded headers here would be unsafe
   anyway.
2. **Local dev**: `appUrl` is unset. The Astro proxy forwards
   `X-Forwarded-Host` / `X-Forwarded-Proto` (because `xfwd: true`),
   so the backend reconstructs `http://localhost:4321` — the URL the
   client actually hit — instead of its own `:4000` origin.

If discovery URLs ever come out wrong, check `appUrl` (prod) or the
proxy's `xfwd` flag (dev) first.
