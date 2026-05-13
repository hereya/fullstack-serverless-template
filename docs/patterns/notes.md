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

The minimal template removed these because no Aurora-backed feature
shipped with it. To resurrect, copy them from any prior commit on this
template before the minimal refactor, OR write fresh ones — the Drizzle
+ aws-data-api setup is documented in
[`https://orm.drizzle.team/docs/get-started-postgresql#aws-data-api`](https://orm.drizzle.team/docs/get-started-postgresql#aws-data-api).

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

### 9. Verify

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
