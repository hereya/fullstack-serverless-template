# Pattern: one-shot data migrations

Use this when you need to backfill, transform, or move data between
stores (Aurora → DDB, schema evolution within DDB, populating a new
field on existing rows, etc.) AND you want the work to happen exactly
once across the fleet, with visibility, and without writing scripts
that need IAM creds passed in by hand.

The mechanism: the no-op `migrate.ts` Lambda that's already wired to a
CloudFormation Custom Resource by `hereya/aws-app-lambda`. It fires on
every stack create/update. Each migration is gated by a DDB sentinel —
`hasRun(id)` checks first, `markRun(id)` records completion. Subsequent
deploys skip already-run migrations.

## When NOT to use this

- **Schema migrations on Aurora** — the `notes` pattern already wires
  Drizzle; its own migrate-on-deploy is a separate flow. Re-use that.
- **Per-tenant / per-user data fixes** — those are scripts, not
  migrations. The audit story is "the script I ran", not "the deploy
  that ran it."
- **Anything that needs to wait for a human decision mid-flight** —
  CFn Custom Resources have a 1-hour ceiling and they roll back the
  whole deploy on failure. Don't make a deploy hostage to a manual step.

## Steps

### 1. Add the migrations store helper

Create `apps/backend/src/auth/migrationsStore.ts`:

```ts
// Tracks completed one-shot migrations. Each migration writes an item
// to OAuthStateTable with PK `MIGRATION#<id>`. No TTL — sentinels are
// permanent. Single-table design avoids spinning up another table
// for what's typically a handful of rows over the app's lifetime.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';

let _doc: DynamoDBDocumentClient | null = null;
function doc(): DynamoDBDocumentClient {
  if (!_doc) _doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return _doc;
}

function table(): string {
  const t = process.env.oauthStateTableName;
  if (!t) throw new Error('oauthStateTableName env var missing');
  return t;
}

export async function hasRun(id: string): Promise<boolean> {
  const r = await doc().send(
    new GetCommand({ TableName: table(), Key: { pk: `MIGRATION#${id}` } }),
  );
  return !!r.Item;
}

export async function markRun(id: string): Promise<void> {
  await doc().send(
    new PutCommand({
      TableName: table(),
      Item: {
        pk: `MIGRATION#${id}`,
        completedAt: new Date().toISOString(),
      },
      // Conditional write so a concurrent Lambda losing a race becomes
      // a no-op (the winner already wrote the sentinel).
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  ).catch((err) => {
    // ConditionalCheckFailed = another invocation got there first.
    // Treat as success — the migration is recorded.
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
  });
}
```

### 2. Replace the no-op `migrate.ts` body

`apps/backend/src/migrate.ts` currently returns success without doing
anything. Replace its handler with a loop over a `MIGRATIONS` array:

```ts
import { hasRun, markRun } from './auth/migrationsStore.js';

// Migrations live as plain objects keyed by an immutable id. Append
// new migrations to the end; never reorder or rename. Old ids stay
// here forever as a record of what's been done — `hasRun(id)` is the
// idempotency check, not the array's content.
const MIGRATIONS: Array<{ id: string; run: () => Promise<void> }> = [
  // {
  //   id: '2026-05-aurora-webinar-to-ddb',
  //   run: async () => { /* read Aurora, write DDB */ },
  // },
];

interface CfnEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
}
interface CfnResponse {
  PhysicalResourceId: string;
  Data?: Record<string, string>;
}

export const handler = async (event: CfnEvent): Promise<CfnResponse> => {
  const physicalResourceId =
    event.PhysicalResourceId ?? 'hereya-app-migrations';
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: physicalResourceId };
  }

  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (await hasRun(m.id)) continue;
    console.log(`[migrate] running ${m.id}`);
    await m.run();
    await markRun(m.id);
    ran.push(m.id);
  }

  return {
    PhysicalResourceId: physicalResourceId,
    Data: { ran: ran.join(',') || 'none', ranAt: new Date().toISOString() },
  };
};
```

### 3. Write the migration

Drop a function into the `MIGRATIONS` array. Example: backfill Aurora
`webinar_registrations` rows into the DDB `RegistrationsTable` with the
original `createdAt` preserved.

```ts
import {
  RDSDataClient,
  ExecuteStatementCommand,
} from '@aws-sdk/client-rds-data';
import { addRegistration } from './auth/registrationsStore.js';

// At the top of migrate.ts:
const rds = new RDSDataClient({});

MIGRATIONS.push({
  id: '2026-05-aurora-webinar-to-ddb',
  run: async () => {
    const out = await rds.send(
      new ExecuteStatementCommand({
        resourceArn: process.env.clusterArn!,
        secretArn: process.env.secretArn!,
        database: process.env.databaseName!,
        sql: 'SELECT email, name, created_at FROM webinar_registrations',
      }),
    );
    for (const r of out.records ?? []) {
      const email = r[0]?.stringValue ?? '';
      const name = r[1]?.stringValue ?? '';
      const createdAt = r[2]?.stringValue ?? new Date().toISOString();
      if (!email) continue;
      // addRegistration is idempotent (attribute_not_exists on PutItem),
      // so re-running the migration won't clobber an existing DDB row.
      // To preserve createdAt across the migration, write directly via
      // PutCommand instead of going through addRegistration which
      // stamps a fresh createdAt:
      // ...
    }
  },
});
```

For preserving original timestamps, write to DDB directly rather than
through `addRegistration` (which stamps `new Date()` on every call):

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

await ddb.send(
  new PutCommand({
    TableName: process.env.registrationsTableName!,
    Item: { email, name, createdAt },
    ConditionExpression: 'attribute_not_exists(email)',
  }),
).catch((err) => {
  if (err?.name !== 'ConditionalCheckFailedException') throw err;
  // already migrated — fine
});
```

### 4. Aurora resume retry (only if reading from Aurora)

Aurora Serverless v2 returns `DatabaseResumingException` on the first
call after auto-pause. The Custom Resource Lambda has a 1-hour budget;
a small retry loop covers a ~30s resume:

```ts
async function withAuroraResume<T>(op: () => Promise<T>, max = 12): Promise<T> {
  for (let i = 1; i <= max; i++) {
    try { return await op(); }
    catch (err) {
      if (err?.name !== 'DatabaseResumingException') throw err;
      await new Promise((r) => setTimeout(r, Math.min(5000, 1000 * i)));
    }
  }
  throw new Error('Aurora did not resume in time');
}
```

### 5. Deploy

```bash
hereya deploy -w <workspace>
```

The Custom Resource fires after every other stack resource is in place,
so the migrate Lambda has full IAM and env access. Output is in
CloudWatch under `/aws/lambda/<stack>-MigrationHandler<...>`.

Subsequent deploys see `hasRun(id) === true` for every entry in the
array and skip. The MIGRATIONS array is the historical record — never
delete entries, even after they've run. (Reordering or renaming an id
is fine; the sentinel is on the id, not the position.)

## Cold-start alternative (when a deploy migration won't work)

If you need a migration that depends on per-tenant state, runs in a
region-by-region rollout, or needs to keep going after a deploy
completes, run it lazily on Lambda cold start:

```ts
// in handler.ts
let migrationsReady: Promise<void> | undefined;
function ensureMigrated(): Promise<void> {
  if (!migrationsReady) {
    migrationsReady = (async () => {
      for (const m of LAZY_MIGRATIONS) {
        if (await hasRun(m.id)) continue;
        await m.run();
        await markRun(m.id);
      }
    })();
  }
  return migrationsReady;
}

export const handler = async (event, context) => {
  await ensureMigrated();
  // …
};
```

Trade-off: the first request after deploy waits on the migration.
Concurrent Lambda starts race on the sentinel (the `attribute_not_exists`
write in `markRun` is the lock — losers no-op cleanly), but you pay
the read+work latency on every cold instance until the sentinel is
visible to it. For an Aurora-touching migration that's 30s+; prefer
the deploy-time path.

## What to think about

- **Idempotency is on YOU.** The framework guarantees each migration
  runs at most once per id — but if your migration is non-idempotent
  internally (e.g. it appends to an audit log every call), a CFn retry
  could duplicate. Make `run()` resumable: it should be safe to call
  twice in a row.
- **Failure aborts the deploy.** A migration that throws fails the
  Custom Resource → CFn rollback → previous Lambda stays live. You'll
  see the error in CloudWatch and the deploy command. Fix and redeploy.
- **Memory ceiling.** The default Lambda memory in `aws-app-lambda`
  is 512 MB. A migration that reads 100k rows into memory will OOM.
  Stream or paginate.
- **Aurora wake-up cost.** If the migration's source is Aurora and the
  cluster's been idle, factor in ~30s of resume latency before the
  first query. Include the retry helper.
- **Deletion semantics.** When the stack is deleted, the migration
  Lambda receives `RequestType: 'Delete'` and should no-op. Migrations
  don't have "undo" — if you need to roll back data, write a new
  forward migration.

## Worked example: the Aurora → DDB backfill we just shipped

The Aurora-to-DDB migration that ran by hand (3 rows from
`webinar_registrations`) could have been a single entry in this array.
What that would have looked like:

```ts
MIGRATIONS.push({
  id: '2026-05-aurora-webinar-to-ddb',
  run: async () => {
    const out = await withAuroraResume(() => rds.send(new ExecuteStatementCommand({
      resourceArn: process.env.clusterArn!,
      secretArn: process.env.secretArn!,
      database: process.env.databaseName!,
      sql: 'SELECT email, name, created_at FROM webinar_registrations',
    })));
    for (const r of out.records ?? []) {
      const email = r[0]?.stringValue;
      const name = r[1]?.stringValue ?? '';
      const createdAt = r[2]?.stringValue ?? new Date().toISOString();
      if (!email) continue;
      await ddb.send(new PutCommand({
        TableName: process.env.registrationsTableName!,
        Item: { email, name, createdAt },
        ConditionExpression: 'attribute_not_exists(email)',
      })).catch((err) => {
        if (err?.name !== 'ConditionalCheckFailedException') throw err;
      });
    }
  },
});
```

Then `hereya deploy` — the rows land in DDB with their original
timestamps. No public-endpoint detour, no lost createdAt, no manual
script invocation.

Lesson: if you find yourself writing a one-off migration script, ask
first whether it belongs in this array.
