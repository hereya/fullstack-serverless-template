# Pattern: notes / CRUD app data (Aurora + Drizzle)

Use this when the user wants a feature with real relational structure —
posts, todos, a knowledge base, anything with joins or transactional
constraints. Aurora Postgres is the right tool; the cost is a ~5s
cold-start delay on the first request after idle, which is acceptable
for authed app data (vs. the public registration form, which we
deliberately keep on DDB to avoid the wake-up tax).

The pattern is named "notes" because the canonical example is a
user-owned notes feature. Substitute your own entity throughout.

## When NOT to use this

- **Simple key-value lookups** → DDB. The `aws/cognito` and
  `aws-ddb-app-state` packages already provision tables for that.
- **Schema-less / per-row variable fields** → DDB. Drizzle is
  strongly-typed; if rows have wildly different shapes, it'll fight you.

## Prerequisites

- The `hereya/aws-postgres-serverless` package is already in
  `hereya.yaml` (provisioned, idle). No infra change needed — only code.

## Steps

### 1. Re-introduce the `db/` directory

```
apps/backend/src/db/
├── client.ts        ← Drizzle client over the AWS Data API
├── migrator.ts      ← Drizzle migrator (runs SQL from drizzle/)
├── resilience.ts    ← warmupCluster + dbCall (retry on Aurora resume)
└── schema.ts        ← table definitions
```

The minimal template doesn't ship these — they're added by this
pattern. Canonical sources below; drop them in verbatim.

**`src/db/client.ts`**

```ts
import { drizzle } from 'drizzle-orm/aws-data-api/pg';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { loadEnv } from '../env.js';
import * as schema from './schema.js';

let _rds: RDSDataClient | null = null;
function rds(): RDSDataClient {
  if (!_rds) _rds = new RDSDataClient({});
  return _rds;
}

let _db: ReturnType<typeof makeDb> | null = null;

function makeDb() {
  const env = loadEnv();
  return drizzle(rds(), {
    database: env.databaseName,
    resourceArn: env.clusterArn,
    secretArn: env.secretArn,
    schema,
  });
}

export function getDb() {
  if (!_db) _db = makeDb();
  return _db;
}

export { schema };
```

**`src/db/resilience.ts`**

```ts
import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';
import { loadEnv } from '../env.js';

let _rds: RDSDataClient | null = null;
function rds(): RDSDataClient {
  if (!_rds) _rds = new RDSDataClient({});
  return _rds;
}

const TRANSIENT_ERROR_NAMES = new Set([
  'DatabaseResumingException',
  'ServiceUnavailableException',
  'ThrottlingException',
]);

const TRANSIENT_MESSAGE_PATTERNS = [
  /resuming/i,
  /cluster is being resumed/i,
  /database is currently unavailable/i,
  /communications link failure/i,
];

function singleIsTransient(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string };
  if (e.name && TRANSIENT_ERROR_NAMES.has(e.name)) return true;
  if (e.message) {
    for (const re of TRANSIENT_MESSAGE_PATTERNS) {
      if (re.test(e.message)) return true;
    }
  }
  return false;
}

// Drizzle wraps the underlying SDK error in a `DrizzleQueryError` whose
// `.cause` holds the real `DatabaseResumingException`. Walk the chain.
export function isTransient(err: unknown): boolean {
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (singleIsTransient(cur)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export type Warmup = () => Promise<void>;

/**
 * Run a Drizzle/Data API operation with one warmup-and-retry on
 * transient errors. On the happy path, no warmup is called and no
 * retry happens.
 *
 *   - On a transient error: invoke `warmup()` exactly once, then retry
 *     `op` exactly once. If the retry also throws, propagate that
 *     error.
 *   - On a non-transient error: propagate immediately, no warmup.
 *   - If `warmup` itself throws: propagate that error (no retry of op).
 */
export async function dbCall<T>(
  op: () => Promise<T>,
  _tag: string,
  warmup?: Warmup,
): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (!isTransient(err)) throw err;
    if (warmup) await warmup();
    return await op();
  }
}

/**
 * Cold-start warmup — kicks the cluster so subsequent queries don't
 * pay the full resume tax. Top-level callers (handler.ts) wrap their
 * own try/catch; `dbCall` itself rethrows warmup failures.
 */
export async function warmupCluster(): Promise<void> {
  const env = loadEnv();
  await rds().send(
    new ExecuteStatementCommand({
      resourceArn: env.clusterArn,
      secretArn: env.secretArn,
      database: env.databaseName,
      sql: 'SELECT 1',
    }),
  );
}
```

**`src/db/migrator.ts`**

```ts
import { migrate } from 'drizzle-orm/aws-data-api/pg/migrator';
import { getDb } from './client.js';
import { dbCall, warmupCluster } from './resilience.js';
import path from 'node:path';
import url from 'node:url';

export async function runMigrations(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dir = typeof (globalThis as any).__dirname === 'string'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? (globalThis as any).__dirname
    : path.dirname(url.fileURLToPath(import.meta.url));

  // dist/db/migrator.js → ../drizzle/   (deployed Lambda)
  // src/db/migrator.ts (dev) → ../../drizzle/
  const candidates = [
    path.join(dir, '..', 'drizzle'),
    path.join(dir, '..', '..', 'drizzle'),
  ];
  let folder: string | undefined;
  const fs = await import('node:fs');
  for (const c of candidates) {
    if (fs.existsSync(c)) { folder = c; break; }
  }
  if (!folder) throw new Error(`drizzle/ folder not found. Tried: ${candidates.join(', ')}`);

  await dbCall(
    () => migrate(getDb(), { migrationsFolder: folder! }),
    'migrate',
    warmupCluster,
  );
}
```

`schema.ts` is feature-specific (the notes example below). Build it
fresh per pattern.

Add deps to `apps/backend/package.json`:

```jsonc
"dependencies": {
  "@aws-sdk/client-rds-data": "^3.700.0",
  "@aws-sdk/client-secrets-manager": "^3.700.0",
  "drizzle-orm": "^0.45.2",
  // …existing
},
"devDependencies": {
  "drizzle-kit": "^0.31.10",
  // …existing
}
```

### 2. Define your schema

In `src/db/schema.ts`, declare the entity:

```ts
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

// Notes carry a plain `userId` matching DDB's authUsersTable PK.
// No FK constraint — the user-of-truth is in DDB.
export const notes = pgTable('notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});
```

### 3. Generate + commit the migration

Add a `drizzle.config.ts` at `apps/backend/`:

```ts
import type { Config } from 'drizzle-kit';
export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  driver: 'aws-data-api',
  dbCredentials: {
    database: process.env.databaseName!,
    resourceArn: process.env.clusterArn!,
    secretArn: process.env.secretArn!,
  },
} satisfies Config;
```

Add a build script and run it:

```bash
# package.json
"scripts": {
  "db:generate": "drizzle-kit generate",
  // …existing
}

cd apps/backend && npm run db:generate
git add drizzle/
```

### 4. Replace the no-op migration Lambda with the real one

`apps/backend/src/migrate.ts` already exists as a no-op (the
aws-app-lambda package requires the Custom Resource handler to exist,
even when there's nothing to migrate). Replace its contents with:

```ts
import { resolveSecrets } from './secrets.js';
import { runMigrations } from './db/migrator.js';

interface CfnCustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
}
interface CfnCustomResourceResponse {
  PhysicalResourceId: string;
  Data?: Record<string, string>;
}

const ready = resolveSecrets();

export const handler = async (
  event: CfnCustomResourceEvent,
): Promise<CfnCustomResourceResponse> => {
  const physicalResourceId = event.PhysicalResourceId ?? 'hereya-app-migrations';
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: physicalResourceId };
  }
  await ready;
  await runMigrations();
  return {
    PhysicalResourceId: physicalResourceId,
    Data: { migratedAt: new Date().toISOString() },
  };
};
```

Update the build script to also ship the `drizzle/` SQL:

```jsonc
"build": "node esbuild.config.mjs && rm -rf dist/drizzle && cp -r drizzle dist/drizzle"
```

The esbuild config already lists `src/migrate.ts` as an entrypoint — no
change needed there.

### 5. Add env-var entries

In `src/env.ts`:

```ts
const schema = z.object({
  // …existing
  clusterArn: z.string().min(1),
  secretArn: z.string().min(1),
  databaseName: z.string().min(1),
});
```

These come from the `aws-postgres-serverless` package's CFn outputs
automatically — no `hereya.yaml` change.

### 6. Add routes + admin handlers

```
apps/backend/src/routes/notes.ts            ← CRUD (auth-gated)
apps/backend/src/mcp/handlers/notes.ts      ← shared handlers
apps/backend/src/mcp/tools/notes.ts         ← MCP tools
```

Wire `notes` in `app.ts`:

```ts
app.route('/api/notes', notes);
```

Register the MCP tools in `src/mcp/server.ts`:

```ts
import { registerNoteTools } from './tools/notes.js';
// …
registerNoteTools(server);
```

Add permission constants in `auth/permissions.ts`:

```ts
NOTES_READ_OWN: 'notes:read:own',
NOTES_WRITE_OWN: 'notes:write:own',
```

The admin role inherits them automatically (derived from `PERMISSIONS`);
a "member" role-seed in `seedRoles.ts` can grant exactly these two.

### 7. Frontend

Add `src/components/Notes.ts` (Lit island with list/create/delete) and
`src/pages/notes.astro` (hosts the island). Cross-link from
`pages/index.astro` and `components/AuthNav.ts` if appropriate.

If you want admin moderation, add an `admin/notes.astro` page + an
`AdminNotes.ts` component (mirror `AdminRegistrations.ts`'s shape).
Update `AdminTabs.ts` to include the new tab.

### 8. Restore the Aurora warmup in handler.ts

The minimal template removed the cold-start `warmupCluster()` call.
Add it back to `apps/backend/src/handler.ts`:

```ts
import { warmupCluster, isTransient } from './db/resilience.js';
// …in the `ready = Promise.all([...])` array:
warmupCluster().catch((err) => {
  console.warn('[handler] cluster warmup failed', err);
}),
```

And mirror it in `dev-server.ts`.

### 9. Tests

The bare template doesn't ship these — the modules + permissions they
exercise don't exist until you apply this pattern. Drop them in
alongside the code.

#### `apps/backend/tests/db-call.test.ts`

Pins the `dbCall` + `isTransient` contract from `src/db/resilience.ts`:
one warmup-and-retry on transient errors, propagate warmup failures,
walk `.cause` chains (Drizzle wraps the SDK error).

```ts
import { describe, it, expect, vi } from 'vitest';
import { dbCall, isTransient } from '../src/db/resilience.js';

// Mirrors the shape AWS SDK + Drizzle hand us when Aurora is paused.
function transientErr(): Error {
  const err = new Error('DrizzleQueryError: Failed query');
  (err as { cause?: unknown }).cause = Object.assign(
    new Error('Aurora DB instance is resuming after being auto-paused.'),
    { name: 'DatabaseResumingException' },
  );
  return err;
}

describe('isTransient', () => {
  it('matches by error name', () => {
    expect(isTransient(Object.assign(new Error('x'), { name: 'DatabaseResumingException' }))).toBe(true);
    expect(isTransient(Object.assign(new Error('x'), { name: 'ThrottlingException' }))).toBe(true);
  });

  it('matches by message pattern', () => {
    expect(isTransient(new Error('cluster is currently resuming'))).toBe(true);
    expect(isTransient(new Error('totally unrelated'))).toBe(false);
  });

  it('walks .cause chains (Drizzle wraps the underlying SDK error)', () => {
    expect(isTransient(transientErr())).toBe(true);
  });
});

describe('dbCall', () => {
  it('does not call warmup on the happy path', async () => {
    const warmup = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await dbCall(fn, 'happy', warmup);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(warmup).not.toHaveBeenCalled();
  });

  it('on transient error: warms cluster, retries the query once, returns success', async () => {
    const warmup = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw transientErr();
      return 'ok';
    });
    const result = await dbCall(fn, 'retry-then-ok', warmup);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(warmup).toHaveBeenCalledTimes(1);
  });

  it('on transient error: gives up after one retry if it still fails', async () => {
    const warmup = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn(async () => { throw transientErr(); });
    await expect(dbCall(fn, 'give-up', warmup)).rejects.toThrow(/DrizzleQueryError/);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(warmup).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a non-transient error', async () => {
    const warmup = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn(async () => { throw new Error('schema mismatch'); });
    await expect(dbCall(fn, 'no-retry', warmup)).rejects.toThrow(/schema mismatch/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(warmup).not.toHaveBeenCalled();
  });

  it('rethrows warmup failure if warmup itself fails', async () => {
    const warmup = vi.fn().mockRejectedValue(new Error('warmup exhausted'));
    const fn = vi.fn(async () => { throw transientErr(); });
    await expect(dbCall(fn, 'warmup-fails', warmup)).rejects.toThrow(/warmup exhausted/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(warmup).toHaveBeenCalledTimes(1);
  });
});
```

#### `apps/backend/tests/notes.test.ts` (integration stub)

Disabled by default — flip the `describe.skip` once `hereya run` has
populated the env vars and migrations have been applied to the dev DB.

```ts
import { describe, it, expect } from 'vitest';

describe.skip('notes (integration)', () => {
  it('creates and lists notes scoped to the current user', async () => {
    // 1. POST /api/notes with a fresh title+body
    // 2. GET /api/notes — expect the new id to appear
    // 3. GET /api/notes as a different user — expect it NOT to appear
    expect(true).toBe(true);
  });
});
```

For unit-style tests of the routes themselves (without a live cluster),
mirror the mock scaffolding from
[`docs/patterns/attachments.md`'s test section](attachments.md) —
mock `getDb()` to return a Drizzle-shaped chain that consumes a
queued result, so each test enqueues the rows it expects.

#### Extend `apps/backend/tests/permissions.test.ts`

The bare template's `permissions.test.ts` tests `roleHasPermission`
with `USERS_LIST` / `REGISTRATIONS_LIST` only. Once this pattern adds
`MEMBER_PERMISSIONS` + `NOTES_*` constants, append these to assert the
new shape holds:

```ts
// add to the existing 'PERMISSIONS / ALL_PERMISSIONS' describe block:

import { MEMBER_PERMISSIONS } from '../src/auth/permissions.js';

it('MEMBER_PERMISSIONS is a strict subset of ALL_PERMISSIONS', () => {
  for (const p of MEMBER_PERMISSIONS) {
    expect(ALL_PERMISSIONS).toContain(p);
  }
  expect(MEMBER_PERMISSIONS.length).toBeLessThan(ALL_PERMISSIONS.length);
});

it('MEMBER_PERMISSIONS does NOT grant any users:* permission', () => {
  expect(MEMBER_PERMISSIONS).not.toContain(PERMISSIONS.USERS_LIST);
  expect(MEMBER_PERMISSIONS).not.toContain(PERMISSIONS.USERS_ADD);
  expect(MEMBER_PERMISSIONS).not.toContain(PERMISSIONS.USERS_SUSPEND);
});

it('a member role grants the notes permissions but no users:* perms', async () => {
  rolesSpies.getRole.mockResolvedValue({
    roleName: 'member',
    permissions: new Set<string>([
      PERMISSIONS.NOTES_READ_OWN,
      PERMISSIONS.NOTES_WRITE_OWN,
    ]),
    createdAt: '2025-01-01',
  });
  expect(await roleHasPermission('member', PERMISSIONS.NOTES_READ_OWN)).toBe(true);
  expect(await roleHasPermission('member', PERMISSIONS.USERS_LIST)).toBe(false);
});
```

### 10. Verify

```bash
cd apps/backend
npm install            # picks up Drizzle + pg deps
npm run db:generate    # confirms drizzle/ is up to date with schema.ts
npm test
npm run build          # confirms esbuild bundles both entrypoints
```

End-to-end, after `hereya deploy`: visit `/notes` while logged in,
create a note, refresh — it should persist. Also call the MCP tool
`notes_list` from Claude Desktop to confirm both surfaces work.

## What to think about

- **Per-user filtering**: every `notes.ts` route MUST filter by the
  authenticated user's id from `c.get('user').id`. Don't trust a `userId`
  in the request body. The admin role can bypass this in moderation
  routes (gated on a separate permission).
- **Migrations are forward-only.** Don't edit a committed migration —
  generate a new one. The migrate Lambda is idempotent (Drizzle tracks
  applied migrations in `__drizzle_migrations`).
- **Cold-start tax** is real. Authed user-facing routes that hit Aurora
  will wait ~5s after idle. Plan for it: render skeletons on the
  frontend, surface "warming up..." text after 1s if the request hasn't
  responded. The pattern doesn't try to hide this.
