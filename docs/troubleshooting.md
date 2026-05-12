# Troubleshooting

Symptom → fix. Every fix is a **code change in this repo** or a
**`hereyaconfig/hereyavars/` edit**. Nothing here asks you to touch
`hereya.yaml`, package internals, or invoke `hereya` CLI commands —
those are owned by the user's Hereya skill.

---

## Lit element renders unstyled

**Symptom**: a `<hy-*>` island shows up on the page but Tailwind utility
classes inside it have no visual effect — looks like raw, unstyled DOM.

**Cause**: the page is using `client:load` instead of `client:only="lit"`.
`@astrojs/lit` SSRs Lit elements via Declarative Shadow DOM
(`<template shadowrootmode="open">…</template>`). The browser attaches a
shadow root and renders the template inside it. Document-level CSS
(your global Tailwind stylesheet) **doesn't cross the shadow
boundary**, so utility classes inside the shadow root resolve to
nothing.

**Fix**: change the directive on the page:

```diff
- <HyFoo client:load />
+ <HyFoo client:only="lit" />
```

With `client:only`, SSR is skipped entirely. The element ships as an
empty `<hy-foo>`; on client mount the LitElement's overridden
`createRenderRoot() { return this; }` renders into Light DOM where
document-level Tailwind applies.

---

## Nav shows "Login" but the page underneath shows authed data

**Symptom**: a freshly-opened tab on the deployed app shows the anon nav
(Home, About, Subscribe, Login) — but navigating to `/dashboard` shows
the user's actual notes / data anyway.

**Cause**: a transient `/api/auth/me` failure (cold Lambda start, 5xx,
network blip) was caught by `AuthNav` and persisted as `'anon'` in
`sessionStorage`. Subsequent page navigations within the tab read that
stale cache and never re-fetch. The dashboard's own `/me` call, made
later when the Lambda is warm, succeeds — hence the contradiction.

**Fix**: already in the shipped code. Verify:

- `apps/frontend/src/components/AuthNav.ts` only calls
  `writeCache({ state: 'anon', … })` when the error message starts with
  `'401'`. Other errors (5xx, network) flip the visible state to anon
  but leave the cache empty so the next page mount retries.
- A `storage` event listener in `AuthNav.firstUpdated()` reacts to the
  `hereya_auth_sync_v1` key bumped on login/logout to keep sibling tabs
  in sync.

If you reintroduced AuthNav from scratch (e.g., after a `#static-only`
downgrade), make sure both behaviors are present.

---

## Skeleton flashes briefly before content loads

**Symptom**: on a fast network / warm cache, a Lit island renders the
loading skeleton for ~50 ms before content replaces it — visually
jarring.

**Cause**: the island shows the skeleton the instant it mounts. If the
fetch resolves before the user perceives anything (~200 ms), the
skeleton becomes a flicker rather than feedback.

**Fix**: the `DeferredLoadingController` in
`apps/frontend/src/lib/skeleton.ts` already solves this — but you have
to use it correctly. Two checks:

1. The island instantiates one: `private loadingDelay = new DeferredLoadingController(this);`
2. The loading branch of `render()` does:

   ```ts
   if (this.loading || this.loadingDelay.holdSkeleton) {
     return this.loadingDelay.deferred(this.renderSkeleton());
   }
   ```

`holdSkeleton` keeps the skeleton visible for a minimum of 300 ms once
shown (no flash). `deferred()` returns `nothing` for the first 200 ms
(no skeleton if data lands fast).

---

## Custom domain not validated after first deploy

**Symptom**: deploy succeeded, `https://<domain>` is unreachable, and
the CloudFront distribution has no aliases.

**Cause**: external-DNS mode (you pinned `domain` in the hereyavars).
Deploy is three passes; first one only emits the DNS records the user
must add at their provider.

**Fix**: see [`custom-domain.md#mode-b--external-dns`](custom-domain.md#mode-b--external-dns).
Copy the six `dnsRecord*` outputs to the user's DNS provider, redeploy
twice more (passes two and three).

If the user's domain is on Route 53 in the workspace's account already,
flip to Mode A — it's one pass, no manual DNS.

---

## Orphan S3 attachment with `AccessDenied` on delete

**Symptom**: in the backend log, on attachment delete:

```
[attachments.delete] failed to remove S3 object notes/.../foo.png
AccessDenied: User: …/dev-user is not authorized to perform: s3:DeleteObject on resource: arn:aws:s3:::bucket/notes/.../foo.png
```

But the row was deleted successfully and the UI is fine.

**Cause**: a legacy attachment that pre-dates the `hereya/aws-file-storage`
prefix scoping. The S3 key lives at `notes/.../foo.png` (bucket root)
while the dev IAM policy now only grants access to `<s3Prefix>/*`. New
attachments go to `<s3Prefix>/notes/.../foo.png` and delete fine —
this only affects old data.

**Fix**: it's a one-off cleanup, not an ongoing issue. The
`console.warn` in `apps/backend/src/routes/notes.ts` is the correct
behavior (best-effort S3 cleanup, DB is source of truth). To actually
reap the orphans, the user runs `aws s3 rm …` with admin creds — not
the agent's job.

---

## `npm test` fails after I added a backend route

**Symptom**: a test suite that was green before adding a route is now
red.

**Common causes**:

1. **Route not registered in `app.ts`** — the route file exports a Hono
   sub-app, but you forgot the `app.route('/api/…', myRoute)` line.
2. **Missing mock in `tests/setup.ts`** — the new route calls a module
   (e.g., a fresh `email/foo.ts`) that hasn't been mocked. The test
   tries to make a real network call and times out.
3. **DDB mocking pattern broken** — if the new route uses
   `aws-sdk-client-mock`, make sure the mock client is reset in
   `beforeEach`.

Compare the failing route against `apps/backend/src/routes/notes.ts`
end-to-end. The notes resource is the reference shape — registration,
permission gates, test mocks, all of it.

---

## Local dev says env vars are missing

**Symptom**: `npm run dev -w apps/backend` exits immediately with
something like:

```
Error: bucketName env var missing
```

**Cause**: the Hereya workspace env isn't in scope for the dev process.
The npm scripts assume the user's Hereya skill has already set up the
env (typically via `hereya run --` or a similar mechanism).

**Fix**: defer to the user's Hereya skill. **Don't** try to discover
which env vars are needed and ask the user for them one by one — that's
exactly what the Hereya skill exists to prevent. Tell the user
"workspace env isn't in scope; please run this via the Hereya skill,
or invoke `npm run dev` from within an already-prepared shell."

---

## Aurora connection times out from local dev

**Symptom**: `npm run dev -w apps/backend` starts, but any request that
touches Aurora hangs for 30 s and times out.

**Common causes**:

1. **AWS creds missing** — the Data API client uses the dev IAM user's
   creds. If `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` aren't in
   `process.env`, the SDK silently waits on credential resolution.
   Confirm with the user that the Hereya skill exposed them.
2. **Aurora paused** — Aurora Serverless v2 can scale to 0 ACU and take
   ~30 s to wake on the first query. The backend's `db/resilience.ts`
   wraps queries with retry; if the cluster is genuinely paused, the
   first request just takes a while. Subsequent requests are fast.

---

## I added a Lit island but `client:only="lit"` errors

**Symptom**: build-time or runtime error mentioning `lit`, `customElement`,
or a renderer.

**Common causes**:

1. **The element wasn't registered**. The `@customElement('hy-foo')`
   decorator runs only when the module is imported. Make sure the
   `.astro` page imports the class:

   ```astro
   ---
   import { HyFoo } from '../components/Foo';  // ← side-effect registers <hy-foo>
   ---
   <HyFoo client:only="lit" />
   ```

2. **Missing `HTMLElementTagNameMap` declaration**. TypeScript can't
   type-check JSX/Astro usage without it:

   ```ts
   declare global {
     interface HTMLElementTagNameMap {
       'hy-foo': HyFoo;
     }
   }
   ```

3. **Light DOM not set**. If you forgot
   `createRenderRoot() { return this; }`, the element renders inside
   its own shadow root — Tailwind doesn't apply, looks broken (see
   first entry in this file).

---

## Two attachments to the same note overwrite each other in S3

**Symptom**: uploading two attachments with the same filename, the
second download serves the first file's content (or vice versa).

**Cause**: someone simplified `attachmentKey()` to drop the
`attachmentId` UUID segment.

**Fix**: the key shape MUST be
`<s3Prefix>/notes/<noteId>/<attachmentId>/<filename>`. The
`attachmentId` is what makes collisions impossible — same filename, same
note, two different attachments still get distinct S3 keys.

---

## ## MCP client says auth failed

**Symptom**: Claude Desktop (or another MCP client) shows "authentication
failed" or repeatedly re-runs the OAuth flow.

**Common causes**:

1. **Access token expired** — they last 24h. The client should
   automatically refresh; if it doesn't, disconnect + reconnect.
2. **Token revoked** — check `/admin/integrations`; if you revoked
   the client, that's expected. Connect again from the client.
3. **User suspended** — `auth/mcpAuth.ts` short-circuits if the user
   was suspended after the token was issued. Unsuspend, retry.
4. **Cold-started Aurora** — first MCP request after a long idle
   period may time out because `oauth_tokens` lookup wakes Aurora.
   The `dbCall` resilience helper retries, but extreme cold-starts
   can exceed the client's timeout. Retry once.

## MCP `tools/list` is empty or missing tools I added

**Symptom**: Connected fine but the agent doesn't see the tool you
just added.

**Common causes**:

1. The tool registration call (`registerWidgetTools(server)`) isn't
   wired in `apps/backend/src/mcp/server.ts`. Add the import + the
   call inside `buildMcpServer()`.
2. The tool file isn't imported anywhere — confirm `mcp/tools/widgets.ts`
   is reachable from the build.
3. You redeployed but the MCP client is using a cached `tools/list`
   response. Reconnect or restart the client.

## MCP tool returns data but the model only sees the summary

**Symptom**: in Claude.ai (or another web MCP host), calling
`users_list` shows a "rendered output" panel with the actual user
table, but the model's reply only says "Found 1 user(s)" and can't
answer follow-ups about email/role/etc.

**Cause**: the tool put the JSON payload in `structuredContent` but
not in `content[0].text`. Many hosts surface `structuredContent` only
as a UI widget; the model itself only ever reads `content[0].text`. If
that text is just a summary, the model is blind to the data.

**Fix**: every tool's success return must include both the summary AND
the data as text. The shared `ok()` helper in
`apps/backend/src/mcp/toolHelpers.ts` does this for you — it appends
`JSON.stringify(data, null, 2)` after the summary. If you wrote a tool
that bypasses the helper and returns its own `{ content: [...] }`,
inline the data there too.

The MCP spec requires this for back-compat: "a tool that returns
structured content SHOULD also return functionally equivalent
unstructured content."

---

## Claude.ai rejects a tool with `String should match pattern '^[a-zA-Z0-9_-]{1,64}$'`

**Symptom**: connecting the MCP to Claude.ai surfaces a yellow toast:

```
tools.N.FrontendRemoteMcpToolDefinition.name: String should match pattern '^[a-zA-Z0-9_-]{1,64}$'
```

**Cause**: a tool registered with a name that contains a `.` (e.g.
`users.list`). Claude.ai's host validates tool names against
`^[a-zA-Z0-9_-]{1,64}$` and rejects dot-namespaced names outright. The
Claude Desktop / Claude Code clients are more lenient — they accept
the dot and rewrite to underscore internally — so a server can pass
Desktop tests and still fail in Claude.ai.

**Fix**: rename to `<resource>_<action>` with underscores. Update both
the `server.registerTool('...')` call AND any doc / comment that
references the old name. The pattern also caps name length at 64 — keep
names short.

---

## Deployed app's OAuth flow lands the user on `*.execute-api.*` and 404s

**Symptom**: connecting an MCP client to the deployed app, the browser
ends up at e.g. `https://abcd1234.execute-api.<region>.amazonaws.com/login?next=…`
and gets a 404.

**Cause**: the `/.well-known/oauth-authorization-server` discovery doc
emitted the **API Gateway origin URL** instead of the public domain.
That happens when `process.env.appUrl` isn't set on the running Lambda
— `routes/wellKnown.ts` then falls back to `req.url`, which CloudFront
has stripped of the public Host header (the
`ALL_VIEWER_EXCEPT_HOST_HEADER` policy). Once the discovery doc has the
wrong URL, the client sends the browser to that URL, and the relative
redirect to `/login` resolves against it → 404 because /login is an
S3-hosted Astro page that only CloudFront knows how to route to.

**Fix**: ensure the deployed Lambda actually has `appUrl` in its env.
`hereya/aws-app-lambda >= 0.4.1` injects it automatically (mirroring
the `appUrl` CfnOutput into the Lambda's environment). Bump the pin
in `hereya.yaml` to at least `0.4.1` and redeploy. Verify with:

```sh
curl https://<public-domain>/.well-known/oauth-authorization-server | jq .issuer
```

It should print `https://<public-domain>`. If it prints
`*.execute-api.*` instead, the env var didn't make it through —
redeploy the `aws-app-lambda` pass and check Lambda env in the console.

---

## MCP DCR fails with 400

**Symptom**: client says "registration failed" with a 400.

**Common causes**:

1. The `redirect_uris` field isn't an array of valid URLs. Per the
   route's allow-list, valid means `https://...` OR a loopback
   `http://127.0.0.1[:port]` / `http://[::1][:port]` / `http://localhost[:port]`.
2. The body wasn't JSON. Per RFC 7591 the endpoint expects JSON.

---

Things that are explicitly NOT in this troubleshooting doc

- **CDK bootstrap version too old** / Hereya executor failures /
  package install errors on the remote executor — those are deploy-time
  issues owned by the user's Hereya skill, not the agent.
- **Version-bump fixes for past package bugs** — the template's pinned
  versions already include the fixes. If the user genuinely needs a
  different package version, that's a `hereya.yaml` change owned by the
  template maintainer, not the agent.
