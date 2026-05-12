# Adding features

Cookbook. Each recipe is the smallest correct change, plus the test
command that proves it.

Reminder: **`hereya.yaml` is read-only**. If a recipe ever feels like it
needs a new package, stop — the user should add that through their
Hereya skill first.

---

## Add a public page

1. Create the file:

   ```bash
   # apps/frontend/src/pages/<name>.astro
   ```

   ```astro
   ---
   import Base from '../layouts/Base.astro';
   ---
   <Base title="<Name>">
     <h1>...</h1>
     <p>...</p>
   </Base>
   ```

2. Visit `http://localhost:4321/<name>` to confirm.

**Verify**: `npm run build -w apps/frontend` exits 0.

---

## Add an auth-gated page

1. Add the Lit island first ([next recipe](#add-a-lit-island)). The
   island calls `/api/auth/me` in `firstUpdated()` and redirects on
   401:

   ```ts
   try {
     this.user = await api<Me>('/api/auth/me');
   } catch (err) {
     if (err instanceof Error && err.message.startsWith('401')) {
       window.location.replace('/login?next=' + location.pathname);
       return;
     }
     throw err;
   }
   ```

2. Add the page wrapper:

   ```astro
   ---
   import Base from '../layouts/Base.astro';
   import { HyMyPage } from '../components/MyPage';
   ---
   <Base title="…">
     <HyMyPage client:only="lit" />
   </Base>
   ```

**Verify**: anon visit → bounced to `/login?next=…`; authed → page
renders.

---

## Add a Lit island

Naming: class `HyFoo` → custom tag `hy-foo` → file
`apps/frontend/src/components/Foo.ts`. Light DOM. Loading state via the
shared skeleton primitives.

```ts
import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { api } from '../lib/api';
import { DeferredLoadingController, skelTitle, skelInput } from '../lib/skeleton';

@customElement('hy-foo')
export class HyFoo extends LitElement {
  createRenderRoot() { return this; }  // Light DOM → Tailwind applies

  @state() private loading = true;
  @state() private data: Thing | null = null;
  private loadingDelay = new DeferredLoadingController(this);

  async firstUpdated() {
    try {
      this.data = await api<Thing>('/api/things/me');
    } finally {
      this.loading = false;
    }
  }

  private renderSkeleton() {
    return html`<div class="space-y-3">${skelTitle('w-32')}${skelInput()}</div>`;
  }

  render() {
    if (this.loading || this.loadingDelay.holdSkeleton) {
      return this.loadingDelay.deferred(this.renderSkeleton());
    }
    return html`<div>…actual content from this.data…</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'hy-foo': HyFoo;
  }
}
```

Register in a page:

```astro
---
import { HyFoo } from '../components/Foo';
---
<HyFoo client:only="lit" />
```

**Always `client:only="lit"`** — never `client:load`. See
[troubleshooting.md](troubleshooting.md) for why.

**Verify**: `npm run build -w apps/frontend` exits 0; page renders the
island.

---

## Add an API route

1. Create the route file:

   ```ts
   // apps/backend/src/routes/things.ts
   import { Hono } from 'hono';
   import { z } from 'zod';
   import { authMiddleware } from '../middleware/auth.js';
   import { requirePermission } from '../middleware/requirePermission.js';
   import { PERMISSIONS } from '../auth/permissions.js';

   export const things = new Hono();
   things.use('*', authMiddleware);

   things.get('/', requirePermission(PERMISSIONS.THINGS_READ_OWN), async (c) => {
     const u = c.get('user');
     // …query DB scoped by u.id…
     return c.json([]);
   });
   ```

2. Register in `apps/backend/src/app.ts`:

   ```ts
   import { things } from './routes/things.js';
   app.route('/api/things', things);
   ```

3. Mirror `apps/backend/tests/notes.test.ts` for the test file.

**Verify**: `npm test -w apps/backend` + `npm run typecheck -w apps/backend`.

### Admin routes: ALSO add a matching MCP tool

If the route lives under `/api/admin/*`, you MUST also expose a matching
MCP tool — see [`docs/mcp.md`](mcp.md#convention-every-new-admin-feature-exposes-an-mcp-tool).
Concretely:

1. Extract the route's logic into a shared handler at
   `apps/backend/src/mcp/handlers/<resource>.ts`. The handler is a
   plain function taking `(input)` and returning a serializable result;
   it throws typed `Error` subclasses for known failure cases.
2. The HTTP route in `routes/admin.ts` becomes a thin adapter that
   parses the request and maps handler errors to HTTP statuses.
3. Add the matching tool in `apps/backend/src/mcp/tools/<resource>.ts`
   with the SAME permission constant — see the next recipe.

Reference shape: `users_set_suspended` end-to-end. Both surfaces
share `setSuspendedHandler` in `mcp/handlers/users.ts`, and the
last-admin safeguard fires identically whether the call came from
HTTP or MCP.

---

## Add an MCP tool

Tools live under `apps/backend/src/mcp/tools/<resource>.ts` and call
into a shared handler under `apps/backend/src/mcp/handlers/<resource>.ts`.
Every tool checks a permission via the `withPermission` helper.

1. If the tool needs a new permission, add it to
   `apps/backend/src/auth/permissions.ts`. It lands in
   `ALL_PERMISSIONS` automatically (admin keeps everything).
2. Write the shared handler:

   ```ts
   // apps/backend/src/mcp/handlers/widgets.ts
   export async function listWidgetsHandler() {
     return { widgets: await /* query */ };
   }
   ```

3. Write the tool:

   ```ts
   // apps/backend/src/mcp/tools/widgets.ts
   import { z } from 'zod';
   import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
   import { PERMISSIONS } from '../../auth/permissions.js';
   import { listWidgetsHandler } from '../handlers/widgets.js';
   import { ok, withPermission } from '../toolHelpers.js';

   export function registerWidgetTools(server: McpServer): void {
     server.registerTool(
       // Tool names: <resource>_<action>, lower-case, underscores, no
       // dots. Claude.ai's MCP host validates against
       // ^[a-zA-Z0-9_-]{1,64}$ and rejects dot-namespaced names.
       'widgets_list',
       {
         description: 'List all widgets.',
         inputSchema: { /* zod fields, or empty {} for no args */ },
       },
       async (_args, extra) =>
         withPermission(extra, PERMISSIONS.WIDGETS_LIST, async () => {
           const data = await listWidgetsHandler();
           return ok(data, `Found ${data.widgets.length} widget(s).`);
         }),
     );
   }
   ```

4. Register in `apps/backend/src/mcp/server.ts`:

   ```ts
   import { registerWidgetTools } from './tools/widgets.js';
   // inside buildMcpServer():
   registerWidgetTools(server);
   ```

5. Add a test in `apps/backend/tests/mcp.test.ts` mirroring an existing
   tool test.

**Hard rules** ([`docs/mcp.md`](mcp.md#hard-rules-additive-to-claudemd)):
do NOT add a tool that runs migrations, executes raw SQL, alters
tables, or otherwise mutates DB structure. Data mutations on existing
tables are fine; structural changes are not.

**Verify**: `npm test -w apps/backend`.

---

## Add a permission

1. In `apps/backend/src/auth/permissions.ts`:

   ```ts
   export const PERMISSIONS = {
     …existing…,
     THINGS_READ_OWN: 'things:read:own',
     THINGS_WRITE_OWN: 'things:write:own',
   } as const;
   ```

2. Add to a role's defaults in the same file:

   ```ts
   export const MEMBER_PERMISSIONS = [
     …existing…,
     PERMISSIONS.THINGS_READ_OWN,
     PERMISSIONS.THINGS_WRITE_OWN,
   ];
   ```

3. Re-deploy. `seedRoles.ts` upserts only-if-missing, so existing role
   rows in DDB are **NOT** trampled — the default applies only to fresh
   roles. To grant the new permission to roles that already exist, do
   it via the admin UI (`/admin/users`) or directly in DDB.

**Verify**: `npm test -w apps/backend` still passes.

---

## Add a DB table

1. Edit `apps/backend/src/db/schema.ts`:

   ```ts
   export const things = pgTable('things', {
     id: uuid('id').primaryKey().defaultRandom(),
     userId: uuid('user_id').notNull(),
     name: text('name').notNull(),
     createdAt: timestamp(…).defaultNow().notNull(),
   });
   ```

2. Generate the migration:

   ```bash
   npm run db:generate -w apps/backend
   ```

3. Commit the produced SQL file in `apps/backend/drizzle/`.

4. Apply locally:

   ```bash
   npm run db:migrate
   ```

**Verify**: `npm test -w apps/backend` (drizzle types still compile).

Note: when the Lambda is deployed, the `aws-app-lambda` package runs
the migrations automatically via a CloudFormation Custom Resource —
you don't need to invoke anything manually for prod.

---

## Integrate Stripe

Assumes the user's Hereya skill has exposed `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET` into the workspace env via the `secret://`
prefix (so they land in Secrets Manager + `consolidatedSecret` at
deploy time).

1. Install the SDK:

   ```bash
   npm install stripe -w apps/backend
   ```

2. Wrap the client:

   ```ts
   // apps/backend/src/payments/stripe.ts
   import Stripe from 'stripe';
   let _client: Stripe | null = null;
   export function stripe(): Stripe {
     if (!_client) {
       const key = process.env.STRIPE_SECRET_KEY;
       if (!key) throw new Error('STRIPE_SECRET_KEY missing');
       _client = new Stripe(key);
     }
     return _client;
   }
   ```

3. Checkout route (authed):

   ```ts
   things.post('/checkout', requirePermission(PERMISSIONS.CHECKOUT_BUY), async (c) => {
     const u = c.get('user');
     const { items } = await c.req.json<{ items: { priceId: string; quantity: number }[] }>();
     const session = await stripe().checkout.sessions.create({
       mode: 'payment',
       line_items: items.map((i) => ({ price: i.priceId, quantity: i.quantity })),
       success_url: `${process.env.appUrl}/checkout/success?sid={CHECKOUT_SESSION_ID}`,
       cancel_url: `${process.env.appUrl}/checkout/cancel`,
       client_reference_id: u.id,
     });
     // Insert pending order keyed by session.id …
     return c.json({ url: session.url });
   });
   ```

4. Webhook route (NOT authed — Stripe signs the body):

   ```ts
   // apps/backend/src/routes/stripe-webhook.ts
   import { Hono } from 'hono';
   import { stripe } from '../payments/stripe.js';

   export const webhook = new Hono();
   webhook.post('/', async (c) => {
     const sig = c.req.header('stripe-signature');
     const body = await c.req.text();   // raw body required for sig verification
     let event;
     try {
       event = stripe().webhooks.constructEvent(body, sig!, process.env.STRIPE_WEBHOOK_SECRET!);
     } catch {
       return c.json({ error: 'invalid signature' }, 400);
     }
     if (event.type === 'checkout.session.completed') {
       const s = event.data.object;
       // update orders.status = 'paid' where stripeSessionId = s.id
     }
     return c.json({ received: true });
   });
   ```

5. Register both in `app.ts`. Make sure the webhook is mounted BEFORE
   any body-parsing middleware that consumes the raw body.

**Verify**:

```bash
npm test -w apps/backend   # write a stripe.test.ts that mocks the SDK
# Local exercise: Stripe CLI's `stripe listen --forward-to localhost:4000/api/stripe/webhook`
```

---

## Send an email

`apps/backend/src/email/postmark.ts` already wraps the Postmark client.
Import and use:

```ts
import { sendEmail } from '../email/postmark.js';

await sendEmail({
  to: user.email,
  subject: 'Welcome',
  htmlBody: `<p>Thanks for signing up.</p>`,
});
```

`from` defaults to `process.env.postmarkFromEmail` (which is
`auth@<effective domain>`). Override on the call site if you want
`hello@…` or similar.

**Verify**: write a test that mocks `@postmark/server` and confirms the
expected payload was sent.
