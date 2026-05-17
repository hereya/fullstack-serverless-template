# Pattern: newsletter (public email collector + admin list)

Use this when you want a low-friction "drop your email here" sign-up
that lands in Aurora (so the admin UI can list / export / mail
subscribers later). It's distinct from the richer-registration pattern
because the table is owned by Aurora (not DDB) and there's a
corresponding `/api/admin/subscriptions` admin view.

## When NOT to use this

- **Newsletter that's just a Postmark broadcast list** → skip the
  Aurora table entirely and write straight into Postmark's
  Subscribers API. The downside is you lose ad-hoc query power
  (counts, joins, filtered exports).
- **Per-event RSVP** → use the richer-registration pattern (DDB)
  instead. Events expire; you don't need joinable history.

## Prerequisites

- [notes](notes.md) pattern applied — gives you Drizzle + Aurora + the
  migrator. The schema addition below depends on `src/db/schema.ts`.
- Admin role exists (template default).

## Steps

### 1. Schema

In `src/db/schema.ts`:

```ts
export const newsletterSubscriptions = pgTable('newsletter_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});
```

Run `npm run db:generate` and commit the new SQL.

### 2. Permission constant

In `src/auth/permissions.ts`, add to `PERMISSIONS`:

```ts
NEWSLETTER_LIST: 'newsletter:list',
```

`ALL_PERMISSIONS` (admin grant) updates automatically. `MEMBER_PERMISSIONS`
intentionally does NOT include this one — only admins see the
subscriber list.

### 3. Public route

`src/routes/newsletter.ts`:

- `POST /api/newsletter` — body `{ email }`. Validates email shape,
  then `INSERT … ON CONFLICT DO NOTHING` so re-submits stay 200 (no
  enumeration leak). No auth. Returns 400 on invalid email.

Wire in `app.ts`:

```ts
app.route('/api/newsletter', newsletter);
```

### 4. Admin route

In `src/routes/admin.ts`, add a `GET /api/admin/subscriptions` handler
behind `requirePermission(PERMISSIONS.NEWSLETTER_LIST)`. Read the rows
via Drizzle (`getDb().select().from(newsletterSubscriptions).orderBy(...).limit(...)`).

### 5. MCP tool (optional)

Per CLAUDE.md hard rule #7, every admin route mirrors as an MCP tool.
Add `src/mcp/tools/newsletter.ts` exposing `newsletter_list` gated on
`PERMISSIONS.NEWSLETTER_LIST`, sharing the same handler module as the
admin route.

### 6. Frontend (optional)

A tiny Lit island `src/components/NewsletterForm.ts` for the public
side; an `AdminSubscriptions.ts` component for the admin panel,
following the existing `AdminUsers.ts` shape.

## Tests (drop into `apps/backend/tests/newsletter.test.ts` and `tests/admin.test.ts` when wiring the pattern)

The minimal template doesn't ship these — the routes they exercise
don't exist until you apply this pattern. Paste them after the routes
are live.

### `apps/backend/tests/newsletter.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.userPoolId = 'pool-id';
process.env.userPoolClientId = 'client-id';
process.env.awsCognitoRegion = 'us-east-1';
process.env.sessionsTableName = 'sessions-table';
process.env.authUsersTableName = 'auth-users-table';
process.env.authRolesTableName = 'auth-roles-table';
process.env.clusterArn = 'arn:aws:rds::cluster';
process.env.secretArn = 'arn:aws:secret::s';
process.env.databaseName = 'appdb';
process.env.postmarkServerToken = 'fake';
process.env.postmarkFromEmail = 'auth@example.test';

// Capture every insert via a chainable fake. The newsletter route does:
//   getDb().insert(table).values({...}).onConflictDoNothing()
// dbCall wraps that in a thenable. We mock the chain.
const insertSpy = vi.fn();
const valuesSpy = vi.fn();
const onConflictDoNothingSpy = vi.fn();

valuesSpy.mockImplementation(() => ({
  onConflictDoNothing: onConflictDoNothingSpy.mockResolvedValue(undefined),
}));
insertSpy.mockImplementation(() => ({ values: valuesSpy }));

vi.mock('../src/db/client.js', () => ({
  getDb: () => ({ insert: insertSpy }),
}));
vi.mock('../src/db/schema.js', () => ({
  users: { __name: 'users' },
  notes: { __name: 'notes' },
  newsletterSubscriptions: { __name: 'newsletter_subscriptions' },
}));

vi.mock('../src/auth/cognito.js', () => ({
  ensureUser: vi.fn(),
  startCustomAuth: vi.fn(),
  respondToCustomChallenge: vi.fn(),
  refreshTokens: vi.fn(),
  getCognito: vi.fn(),
}));
vi.mock('../src/auth/sessions.js', () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  deleteSession: vi.fn(),
  deleteUserSessions: vi.fn(),
}));
vi.mock('../src/auth/users.js', () => ({
  findUserByEmail: vi.fn(),
  findUserById: vi.fn(),
  countUsers: vi.fn(),
  createFirstAdmin: vi.fn(),
  addAllowlistedUser: vi.fn(),
  linkCognitoSub: vi.fn(),
  setSuspended: vi.fn(),
  listUsers: vi.fn(),
  countActiveAdmins: vi.fn(),
}));
vi.mock('../src/email/postmark.js', () => ({ sendOtp: vi.fn() }));

vi.mock('../src/db/resilience.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db/resilience.js')>(
    '../src/db/resilience.js',
  );
  return { ...actual, warmupCluster: vi.fn().mockResolvedValue(undefined) };
});

import { app } from '../src/app.js';

describe('newsletter route', () => {
  beforeEach(() => {
    insertSpy.mockClear();
    valuesSpy.mockClear();
    onConflictDoNothingSpy.mockClear();
    valuesSpy.mockImplementation(() => ({
      onConflictDoNothing: onConflictDoNothingSpy.mockResolvedValue(undefined),
    }));
    insertSpy.mockImplementation(() => ({ values: valuesSpy }));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('POST /api/newsletter inserts a row', async () => {
    const res = await app.request('/api/newsletter', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'fan@example.test' }),
    });
    expect(res.status).toBe(200);
    expect(valuesSpy).toHaveBeenCalledWith({ email: 'fan@example.test' });
    expect(onConflictDoNothingSpy).toHaveBeenCalled();
  });

  it('POST /api/newsletter is idempotent (same email twice still 200)', async () => {
    await app.request('/api/newsletter', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'fan@example.test' }),
    });
    const res = await app.request('/api/newsletter', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'fan@example.test' }),
    });
    expect(res.status).toBe(200);
    expect(insertSpy).toHaveBeenCalledTimes(2);
    expect(onConflictDoNothingSpy).toHaveBeenCalledTimes(2);
  });

  it('POST /api/newsletter returns 400 on invalid email', async () => {
    const res = await app.request('/api/newsletter', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
```

### Admin tests — append to `apps/backend/tests/admin.test.ts`

Three blocks gating subscription read access. Requires extending the
existing `admin.test.ts` mocks: add `NEWSLETTER_LIST` to the
`PERMISSIONS` mock, add `'newsletter:list'` to the admin `ADMIN_ALLOW`
set, register `newsletterSubscriptions: {}` in the `db/schema.js` mock,
and stub `getDb` with a select chain that returns from a mutable
`subsResult.rows`:

```ts
// Append to the top of admin.test.ts, alongside the other shared mocks:
const subsResult: { rows: unknown[] } = { rows: [] };

vi.mock('../src/db/client.js', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve(subsResult.rows),
        }),
      }),
    }),
  }),
}));
```

…then add to the `describe('admin routes', …)` block:

```ts
it('GET /api/admin/subscriptions is auth-gated (401 without cookie)', async () => {
  const res = await app.request('/api/admin/subscriptions');
  expect(res.status).toBe(401);
});

it('GET /api/admin/subscriptions returns 403 for a member (no newsletter:list)', async () => {
  asMember();
  const res = await app.request('/api/admin/subscriptions', {
    headers: { cookie: sessionCookie('sid') },
  });
  expect(res.status).toBe(403);
});

it('GET /api/admin/subscriptions returns the rows for an admin', async () => {
  asAdmin();
  const t = new Date('2025-01-15T10:00:00Z');
  subsResult.rows = [
    { id: 's1', email: 'alice@example.com', createdAt: t },
    { id: 's2', email: 'bob@example.com', createdAt: t },
  ];

  const res = await app.request('/api/admin/subscriptions', {
    headers: { cookie: sessionCookie('sid') },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Array<Record<string, unknown>>;
  expect(body).toHaveLength(2);
  expect(body[0]?.email).toBe('alice@example.com');
  expect(body[1]?.email).toBe('bob@example.com');
});
```

## What to think about

- **No enumeration leak.** `ON CONFLICT DO NOTHING` + always-200 keeps
  an attacker from probing which emails are already subscribed.
- **Rate limit.** A public POST that writes is a spam target. Put a
  CloudFront / WAF rate limit on `/api/newsletter` or accept a captcha
  token in the body.
- **Unsubscribe path.** Not in this pattern — when you start broadcasting,
  add a token-signed `GET /api/newsletter/unsubscribe?t=…` that flips
  the row to a soft-deleted state (a `removed_at` column) so the same
  email can re-subscribe later.
- **No PII beyond email.** If you want a name, opt-in source, or
  language preference, use richer-registration or extend this pattern's
  schema (and update the public form + tests accordingly).
