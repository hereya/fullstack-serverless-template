# Use cases

Five recipes, ordered from simplest to richest. Each builds on the
previous one — start where the user's request lands, then move up when
they ask for more.

**Reminder from [CLAUDE.md](../CLAUDE.md): `hereya.yaml` is read-only.**
Every recipe below is purely a decision about which files exist under
`apps/` and which `hereyavars/*.yaml` parameters are set. The packages
themselves are always provisioned.

After every recipe: `npm test -w <workspace>` must pass before claiming
done.

---

## `#static-only` — marketing site / landing page only

Just pages. No DB, no auth, no email, no S3. The Lambda still gets
deployed (CloudFront fronts the S3 bucket through the same distribution)
but `/api/*` has nothing meaningful to serve.

### Frontend — keep

- `apps/frontend/src/pages/index.astro` — landing
- `apps/frontend/src/pages/about.astro` — public copy
- `apps/frontend/src/layouts/Base.astro` — strip `<HyAuthNav>` out of it, leave a plain `<header>` with marketing nav links
- `apps/frontend/src/styles/global.css`
- Marketing-relevant components

### Frontend — delete

- `apps/frontend/src/pages/{dashboard,login,subscribe}.astro`
- `apps/frontend/src/pages/admin/` (whole directory)
- `apps/frontend/src/components/{AuthNav,LoginForm,Dashboard,Admin*,Attachments,Newsletter}.ts`
- `apps/frontend/src/lib/redirectIfAuthed.ts`

### Backend — delete

Everything except the bare Hono app + a health probe:

- `apps/backend/src/routes/{auth,admin,notes,newsletter,public}.ts`
- `apps/backend/src/{auth,db,email,storage}/` (all directories)
- `apps/backend/src/middleware/{auth,requireAdmin,requirePermission}.ts`
- `apps/backend/src/migrate.ts`
- `apps/backend/drizzle/`
- `apps/backend/tests/*` (then re-add a smoke test)

Strip `apps/backend/src/app.ts` down to a Hono app exposing just
`/api/health` so the deploy doesn't break.

### Hereyavars — no changes required

The packages are still provisioned but inert.

### Verify

```bash
npm test -w apps/frontend
npm run build -w apps/frontend
# Open apps/frontend/dist/index.html — landing should render.
npm run build -w apps/backend
# Open apps/backend/dist/handler.js — should bundle without errors.
```

---

## `#waitlist` — static + email collection

Adds back the minimum to capture emails into Aurora. No auth, no
sessions, no S3.

### Starting state

Either `#static-only` above, or the shipped template after deleting auth
+ admin + notes routes.

### Frontend — add back

- `apps/frontend/src/pages/subscribe.astro`
- `apps/frontend/src/components/Newsletter.ts`

### Backend — add back

- `apps/backend/src/routes/newsletter.ts`
- `apps/backend/src/db/{client,resilience,migrator,schema}.ts`

In `schema.ts`, keep only the `newsletterSubscriptions` table — drop
`notes`, `noteAttachments`, anything user-related. Then:

```bash
npm run db:generate -w apps/backend   # produces a fresh migration in apps/backend/drizzle/
# commit the produced .sql file
```

Optional: add `apps/backend/src/email/postmark.ts` back if you want to
send the subscriber a confirmation email.

### Register the route

In `apps/backend/src/app.ts`:

```ts
import { newsletter } from './routes/newsletter.js';
app.route('/api/newsletter', newsletter);
```

### Verify

```bash
npm test -w apps/backend             # newsletter route test
npm run db:migrate                   # applies migrations against dev Aurora
npm run dev                          # both workspaces
# Visit http://localhost:4321/subscribe, submit an email.
# Then query Aurora (via the user's Hereya skill) to confirm the row.
```

---

## `#auth-gated` — mixed public + protected

Adds back passwordless email-OTP login, sessions, RBAC. Public pages
stay public; some pages are protected.

### Starting state

`#waitlist` above.

### Backend — add back

- `apps/backend/src/auth/` (all of it: `cognito.ts`, `users.ts`, `roles.ts`, `sessions.ts`, `seedRoles.ts`, `permissions.ts`)
- `apps/backend/src/middleware/auth.ts`
- `apps/backend/src/middleware/requirePermission.ts`
- `apps/backend/src/email/postmark.ts` (auth depends on it for OTP delivery)
- `apps/backend/src/routes/auth.ts`

### Frontend — add back

- `apps/frontend/src/components/{AuthNav,LoginForm}.ts`
- `apps/frontend/src/lib/redirectIfAuthed.ts`
- `apps/frontend/src/pages/login.astro`
- Put `<HyAuthNav client:only="lit" />` back into `Base.astro`

### Register the auth routes

In `apps/backend/src/app.ts`:

```ts
import { auth } from './routes/auth.js';
app.route('/api/auth', auth);
```

Backend cold-start hook (already in `handler.ts` and `dev-server.ts`):
`await ensureDefaultRolesSeeded()` — make sure that call survived the
purge.

### Pattern — protect a new route

```ts
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { PERMISSIONS } from '../auth/permissions.js';

route.use('*', authMiddleware);
route.get('/', requirePermission(PERMISSIONS.MY_THING), async (c) => { … });
```

### Pattern — add a new permission

In `apps/backend/src/auth/permissions.ts`:

```ts
export const PERMISSIONS = {
  …existing…,
  MY_NEW_THING: 'my-thing:read',
} as const;

// add to whichever role(s) should have it by default:
export const MEMBER_PERMISSIONS = [
  …existing…,
  PERMISSIONS.MY_NEW_THING,
];
```

`seedRoles.ts` upserts only-if-missing on cold start, so existing role
rows in DDB are NOT overwritten — only new ones get the default. If you
need an admin to be able to grant the new permission to existing roles
right now, do it through the admin UI / DDB console.

### Verify

```bash
npm test -w apps/backend
npm run dev
# - Hit a protected route anon (curl -i http://localhost:4321/api/protected) → 401
# - Visit /login, request OTP, paste code → /dashboard renders
# - Hit the protected route with the resulting cookie → 200
```

---

## `#fullstack` — current state (notes demo)

This is what the template ships as. Don't delete anything; build on top.

The `notes` resource end-to-end is the reference shape for any CRUD
entity:

- Table: `notes` in `apps/backend/src/db/schema.ts`
- Route: `apps/backend/src/routes/notes.ts`, registered in `app.ts`
- Permission gates: `NOTES_READ_OWN`, `NOTES_WRITE_OWN`
- Frontend island: `apps/frontend/src/components/Dashboard.ts`
- Page: `apps/frontend/src/pages/dashboard.astro`
- Test: `apps/backend/tests/notes.test.ts` — copy its shape exactly.

### Pattern — add a new CRUD entity (e.g., `tasks`)

1. Add the table to `schema.ts`:
   ```ts
   export const tasks = pgTable('tasks', {
     id: uuid('id').primaryKey().defaultRandom(),
     userId: uuid('user_id').notNull(),
     title: text('title').notNull(),
     done: boolean('done').notNull().default(false),
     createdAt: timestamp(…).defaultNow().notNull(),
   });
   ```
2. Generate the migration:
   ```bash
   npm run db:generate -w apps/backend
   ```
3. Add permissions in `auth/permissions.ts` (`TASKS_READ_OWN`,
   `TASKS_WRITE_OWN`) and to `MEMBER_PERMISSIONS`.
4. Create `apps/backend/src/routes/tasks.ts` mirroring `routes/notes.ts`
   (list, create, delete). Register in `app.ts`.
5. Create `apps/frontend/src/components/Tasks.ts` mirroring
   `components/Dashboard.ts` (Lit element, Light DOM, skeleton via
   `lib/skeleton.ts`).
6. Add a page `apps/frontend/src/pages/tasks.astro` using
   `<HyTasks client:only="lit" />`.
7. Add a test `apps/backend/tests/tasks.test.ts` copying the shape of
   `tests/notes.test.ts`.

### Verify

```bash
npm test -w apps/backend
npm run typecheck -w apps/backend
npm run db:migrate
npm run dev
# Visit /tasks, exercise create/list/delete.
```

---

## `#ecommerce-upgrade` — products + Stripe

Layer on top of `#fullstack`. Two responsibilities the agent owns:
schema + routes. Stripe API keys come from the user's Hereya skill via
the `secret://` mechanism (see [`architecture.md`](architecture.md#env-var-flow)).

### Schema

`apps/backend/src/db/schema.ts`:

```ts
export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  priceCents: integer('price_cents').notNull(),
  stripePriceId: text('stripe_price_id').notNull(),
});

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  stripeSessionId: text('stripe_session_id').notNull().unique(),
  status: text('status').notNull().default('pending'),  // 'pending' | 'paid' | 'failed'
  totalCents: integer('total_cents').notNull(),
  createdAt: timestamp(…).defaultNow().notNull(),
});

export const orderItems = pgTable('order_items', {
  orderId: uuid('order_id').notNull(),
  productId: uuid('product_id').notNull(),
  quantity: integer('quantity').notNull(),
});
```

Then `npm run db:generate -w apps/backend` and commit the produced SQL.

### Routes

- `apps/backend/src/routes/checkout.ts`:
  - `POST /api/checkout/session` (authed, `requirePermission(CHECKOUT_BUY)`)
    - Reads `STRIPE_SECRET_KEY` from `process.env`
    - Creates a Stripe Checkout Session for the cart
    - Inserts a `pending` row into `orders` keyed by `stripeSessionId`
    - Returns the redirect URL
- `apps/backend/src/routes/stripe-webhook.ts`:
  - `POST /api/stripe/webhook` (NOT authed — Stripe signs the body)
  - Verifies the webhook signature with `STRIPE_WEBHOOK_SECRET`
  - On `checkout.session.completed`: flip the corresponding `orders.status` to `paid`
  - Returns 200 fast (Stripe retries on non-2xx)

### Frontend

- Cart state in `localStorage` (or a Lit element that persists it)
- `apps/frontend/src/pages/shop.astro` — product grid
- `apps/frontend/src/pages/checkout/{success,cancel}.astro` — Stripe redirect targets

### Permission

```ts
// auth/permissions.ts
CHECKOUT_BUY: 'checkout:buy',
```

Add to `MEMBER_PERMISSIONS`.

### Stripe SDK

```bash
# in apps/backend
npm install stripe
```

(That's the only npm dep this recipe adds. The agent doesn't touch
`hereya.yaml`; the user's Hereya skill is what exposes
`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` to the workspace env.)

### Verify

```bash
npm test -w apps/backend             # write a stripe.test.ts that mocks the SDK
npm run typecheck -w apps/backend
npm run db:migrate
# Local end-to-end exercise the checkout against Stripe's test mode,
# using Stripe's webhook forwarding tool to reach localhost:4000.
```

See [`adding-features.md#integrating-stripe`](adding-features.md#integrating-stripe)
for the detailed cookbook.
