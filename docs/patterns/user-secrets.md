# Pattern: user-supplied secrets vault (KMS + DDB)

Use this when a feature needs to store **secrets that users (admins or
end users) supply at runtime** — third-party API keys an admin pastes
in, OAuth refresh tokens a user vaults for an external service, webhook
signing secrets, SMTP credentials. The `hereya/aws-secret-vault`
package is already provisioned (visible in `hereya.yaml`); this pattern
is purely code.

## Core design property — write-only from the user's perspective

Once a value is set, **the plaintext is never returned through any
user-facing surface** (HTTP routes, MCP tools, frontend). The
write-only model matches how Stripe, GitHub, Slack, etc. expose API
keys / webhook secrets in their dashboards.

Users can:

- **Set** a new value (first time)
- **Update / rotate** the value
- **Delete** the value
- **List names** + see metadata (existence, `updatedAt`, `last4` for
  fingerprinting like `sk_live_…abcd`)

But never read the plaintext back. The only consumer that can decrypt
is **server-side code that uses the secret to call a third party** —
that code imports from a separate sub-module than the routes/tools do.

This split is enforced by file boundaries:

| File | Exports | Imported by |
|---|---|---|
| `src/vault/index.ts`   | `setSecret`, `deleteSecret`, `listSecretMetadata`, `secretExists` | Routes, MCP tools, anywhere needed |
| `src/vault/internal.ts` | `decryptSecret`                                                     | **Only** code that calls a third-party API on the user's behalf |

A code-review rule is enough — there's no runtime gate — but the split
makes accidental leaks at PR-review time obvious: if a route handler
imports from `vault/internal.ts`, the reviewer pushes back.

## When NOT to use this

- **Operator-set runtime config** (Postmark token, Cognito client id,
  etc.) → keep using `hereyaconfig/hereyavars/` + the
  `hereya/postmark-app-server`-style packages. Those secrets are
  injected at deploy time into the Lambda env via SSM SecureString,
  not at runtime by a user.
- **Large binary blobs** (PDFs, images) → S3. KMS direct-encrypt caps
  at 4 KB plaintext. For larger encrypted payloads, use
  `kms:GenerateDataKey` (already granted) + AES-GCM envelope
  encryption — not shipped here.
- **Plain non-sensitive structured data** → DDB or Aurora directly.

## Storage model

The package provisions:

- A symmetric KMS key (annual rotation, RETAIN on stack delete).
- A DDB table keyed on `(ownerId, secretName)` with PITR + RETAIN.

`ownerId` is a free-form string. The helpers split it into two
conventions:

| Helper namespace | `ownerId` | Use |
|---|---|---|
| `appSecret`  | `"app"`           | App-wide (admin-managed Stripe key, Slack webhook URL) |
| `userSecret` | `"user:<userId>"` | Per-user (OAuth refresh token, user's own SMTP password) |

A `Query` on the partition key lists all secrets for one owner —
that's how the admin UI renders the secret list for `"app"`, and how
a per-user settings page renders the user's own vault.

## Steps

### 1. Verify the package is in `hereya.yaml`

```yaml
hereya/aws-secret-vault:
  version: 0.1.0
```

(If you scaffolded before this pattern landed, add the block. The
Lambda automatically gets `userSecretsTableName`,
`userSecretsKmsKeyArn`, and the KMS + DDB IAM grants on next deploy.)

### 2. Extend `src/env.ts`

```ts
// hereya/aws-secret-vault
userSecretsTableName: z.string().min(1).optional(),
userSecretsKmsKeyArn: z.string().min(1).optional(),
```

Both optional so the minimal template keeps booting in projects that
don't use the vault yet. Once a project applies this pattern, make
them required.

### 3. Add the vault helper

```
apps/backend/src/vault/
├── index.ts      ← public surface — NEVER returns plaintext
└── internal.ts   ← server-internal — returns plaintext, gate at review time
```

Add deps:

```jsonc
"dependencies": {
  "@aws-sdk/client-kms": "^3.700.0",
  // @aws-sdk/client-dynamodb + @aws-sdk/lib-dynamodb already present
  // via the auth stores
}
```

**`src/vault/index.ts`** — public surface:

```ts
import { KMSClient, EncryptCommand } from '@aws-sdk/client-kms';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

let _kms: KMSClient | null = null;
let _doc: DynamoDBDocumentClient | null = null;
function kms(): KMSClient { return _kms ??= new KMSClient({}); }
function doc(): DynamoDBDocumentClient {
  return _doc ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
}

function table(): string {
  const t = process.env.userSecretsTableName;
  if (!t) throw new Error('userSecretsTableName env var missing — apply the user-secrets pattern');
  return t;
}
function keyArn(): string {
  const k = process.env.userSecretsKmsKeyArn;
  if (!k) throw new Error('userSecretsKmsKeyArn env var missing — apply the user-secrets pattern');
  return k;
}

export interface SecretMetadata {
  name: string;
  updatedAt: string;
  last4: string;
}

const MAX_PLAINTEXT_BYTES = 4096; // KMS direct-encrypt ceiling

export async function setSecret(
  ownerId: string,
  name: string,
  plaintext: string,
): Promise<SecretMetadata> {
  const bytes = Buffer.byteLength(plaintext, 'utf8');
  if (bytes === 0) throw new Error('plaintext cannot be empty');
  if (bytes > MAX_PLAINTEXT_BYTES) {
    throw new Error(`plaintext exceeds ${MAX_PLAINTEXT_BYTES}-byte KMS Encrypt ceiling`);
  }
  const r = await kms().send(new EncryptCommand({
    KeyId: keyArn(),
    Plaintext: Buffer.from(plaintext, 'utf8'),
  }));
  const ciphertextB64 = Buffer.from(r.CiphertextBlob!).toString('base64');
  const last4 = plaintext.slice(-4);
  const now = new Date().toISOString();
  await doc().send(new PutCommand({
    TableName: table(),
    Item: { ownerId, secretName: name, ciphertextB64, last4, updatedAt: now,
            createdAt: now /* on update PutCommand overwrites; getCreatedAt via Get if needed */ },
  }));
  return { name, updatedAt: now, last4 };
}

export async function deleteSecret(ownerId: string, name: string): Promise<void> {
  await doc().send(new DeleteCommand({
    TableName: table(),
    Key: { ownerId, secretName: name },
  }));
}

export async function secretExists(ownerId: string, name: string): Promise<boolean> {
  const r = await doc().send(new GetCommand({
    TableName: table(),
    Key: { ownerId, secretName: name },
    ProjectionExpression: 'secretName',
  }));
  return !!r.Item;
}

export async function listSecretMetadata(ownerId: string): Promise<SecretMetadata[]> {
  const r = await doc().send(new QueryCommand({
    TableName: table(),
    KeyConditionExpression: 'ownerId = :o',
    ExpressionAttributeValues: { ':o': ownerId },
    ProjectionExpression: 'secretName, updatedAt, last4',
  }));
  return (r.Items ?? []).map((i) => ({
    name: i.secretName as string,
    updatedAt: i.updatedAt as string,
    last4: i.last4 as string,
  }));
}

// Convenience wrappers — most call sites use these.
export const appSecret = {
  set:    (name: string, value: string) => setSecret('app', name, value),
  delete: (name: string)                 => deleteSecret('app', name),
  exists: (name: string)                 => secretExists('app', name),
  list:   ()                             => listSecretMetadata('app'),
};
export const userSecret = {
  set:    (userId: string, name: string, value: string) => setSecret(`user:${userId}`, name, value),
  delete: (userId: string, name: string)                 => deleteSecret(`user:${userId}`, name),
  exists: (userId: string, name: string)                 => secretExists(`user:${userId}`, name),
  list:   (userId: string)                                => listSecretMetadata(`user:${userId}`),
};
```

**`src/vault/internal.ts`** — server-internal surface (decrypt):

```ts
// Returns plaintext. Import ONLY from code paths that need the value
// to call a third-party API on the user's behalf (e.g. Stripe SDK
// init, GitHub API client). NEVER import from a route handler or an
// MCP tool — those import from ./index.js instead.
//
// A grep for `from '../vault/internal'` is the quickest review check.

import { KMSClient, DecryptCommand } from '@aws-sdk/client-kms';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

let _kms: KMSClient | null = null;
let _doc: DynamoDBDocumentClient | null = null;
function kms(): KMSClient { return _kms ??= new KMSClient({}); }
function doc(): DynamoDBDocumentClient {
  return _doc ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
}

function table(): string {
  const t = process.env.userSecretsTableName;
  if (!t) throw new Error('userSecretsTableName env var missing');
  return t;
}

export async function decryptSecret(
  ownerId: string,
  name: string,
): Promise<string | null> {
  const r = await doc().send(new GetCommand({
    TableName: table(),
    Key: { ownerId, secretName: name },
  }));
  if (!r.Item?.ciphertextB64) return null;
  const blob = Buffer.from(r.Item.ciphertextB64 as string, 'base64');
  const d = await kms().send(new DecryptCommand({ CiphertextBlob: blob }));
  // CiphertextBlob embeds the key reference, so we don't pass KeyId.
  return Buffer.from(d.Plaintext!).toString('utf8');
}

export const appSecretValue  = (name: string) => decryptSecret('app', name);
export const userSecretValue = (userId: string, name: string) =>
  decryptSecret(`user:${userId}`, name);
```

### 4. Add the permission constant

In `src/auth/permissions.ts`:

```ts
SECRETS_MANAGE: 'secrets:manage',
```

`ALL_PERMISSIONS` is derived from `PERMISSIONS`, so the admin role
auto-inherits it. No `seedRoles.ts` change needed.

### 5. Wire the admin HTTP routes

`src/routes/secrets.ts` — **write-only** surface:

```ts
import { Hono } from 'hono';
import { requirePermission } from '../middleware/requirePermission.js';
import { PERMISSIONS } from '../auth/permissions.js';
import {
  appSecret,
  userSecret,
  setSecret,
  deleteSecret,
  secretExists,
  listSecretMetadata,
} from '../vault/index.js';

export const secrets = new Hono();

// All routes gated by SECRETS_MANAGE. Per-user secrets are scoped by
// the authenticated user automatically; app-scope routes (PATCH/DELETE
// on /app/:name) are open to anyone with the permission.

// --- App-scoped (admin integrations: Stripe key, Slack webhook, …) ---
secrets.put('/app/:name',
  requirePermission(PERMISSIONS.SECRETS_MANAGE),
  async (c) => {
    const name = c.req.param('name');
    const { value } = await c.req.json<{ value: string }>();
    const meta = await appSecret.set(name, value);
    return c.json(meta);
  });

secrets.get('/app',
  requirePermission(PERMISSIONS.SECRETS_MANAGE),
  async (c) => c.json(await appSecret.list()));

secrets.get('/app/:name',
  requirePermission(PERMISSIONS.SECRETS_MANAGE),
  async (c) => {
    const name = c.req.param('name');
    const list = await appSecret.list();
    const meta = list.find((x) => x.name === name);
    if (!meta) return c.json({ error: 'not found' }, 404);
    return c.json(meta);
  });

secrets.delete('/app/:name',
  requirePermission(PERMISSIONS.SECRETS_MANAGE),
  async (c) => {
    await appSecret.delete(c.req.param('name'));
    return c.json({ deleted: true });
  });

// --- User-scoped (per-user OAuth tokens, per-user API keys, …) ------
// Users manage their OWN vault — the userId is the authenticated user,
// not a path parameter. No cross-user access.
secrets.put('/user/:name', /* authenticated user, not necessarily admin */
  async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { value } = await c.req.json<{ value: string }>();
    const meta = await userSecret.set(user.id, c.req.param('name'), value);
    return c.json(meta);
  });

// (GET /user, GET /user/:name, DELETE /user/:name — analogous to app/)
```

**Explicitly NO route returns the plaintext.** No `GET /app/:name/value`,
no `GET /reveal`. If someone proposes one, push back — it breaks the
write-only property.

Register in `src/app.ts`:

```ts
app.route('/api/admin/secrets', secrets);
```

### 6. Matching MCP tools (per CLAUDE.md hard rule #7)

`src/mcp/handlers/secrets.ts` — shared handler module (HTTP routes
should call into this too, to keep one source of truth):

```ts
import { appSecret, userSecret } from '../../vault/index.js';

export const secretsHandlers = {
  appSet:    (name: string, value: string) => appSecret.set(name, value),
  appDelete: (name: string)                 => appSecret.delete(name),
  appList:   ()                              => appSecret.list(),
  appExists: (name: string)                  => appSecret.exists(name),
  // user-scoped: userId comes from c.get('user').id in the MCP tool wrapper
  userSet:    (userId: string, name: string, value: string) => userSecret.set(userId, name, value),
  userDelete: (userId: string, name: string) => userSecret.delete(userId, name),
  userList:   (userId: string)                => userSecret.list(userId),
};
```

`src/mcp/tools/secrets.ts` — register four tools, each gated by
`PERMISSIONS.SECRETS_MANAGE`:

```
secrets_set    (scope: 'app' | 'user', name, value)
secrets_delete (scope: 'app' | 'user', name)
secrets_list   (scope: 'app' | 'user')
secrets_exists (scope: 'app' | 'user', name)
```

**Do NOT register `secrets_get_value` or any tool that returns the
plaintext.** The MCP surface mirrors the HTTP surface by design.

### 7. Consume a decrypted secret server-side

Example — initializing the Stripe SDK from an admin-managed key:

```ts
// src/integrations/stripe.ts
import Stripe from 'stripe';
import { appSecretValue } from '../vault/internal.js';  // ← internal!

let _stripe: Stripe | null = null;
export async function getStripe(): Promise<Stripe> {
  if (_stripe) return _stripe;
  const key = await appSecretValue('stripe-api-key');
  if (!key) throw new Error('stripe-api-key not set in vault');
  _stripe = new Stripe(key, { apiVersion: '2025-04-30.basil' });
  return _stripe;
}
```

The decrypted plaintext only ever lives in the Lambda's heap and inside
the SDK client. It never reaches a route handler's response body.

### 8. Tests

`tests/secrets.test.ts` covers, with KMS mocked via `aws-sdk-client-mock`:

- `setSecret` round trip: set → list shows metadata → delete → list empty
- `setSecret` rejects empty plaintext and > 4 KB plaintext
- `appSecret.list()` returns only items with `ownerId === 'app'`
- `userSecret.list(u1)` doesn't leak `userSecret.list(u2)`'s names
- Admin route `PUT /api/admin/secrets/app/:name`:
  - Unauthed → 401
  - Authed without `SECRETS_MANAGE` → 403
  - Happy path → response body is metadata only (no `value` field)
- **Negative property test**: set a value containing a unique sentinel,
  then call every public route + MCP tool that touches the vault.
  Assert the sentinel never appears in any response body.

## Cost notes

- KMS key: ~$1/month per key, plus ~$0.03 per 10k Encrypt/Decrypt
  calls. Cheap unless a hot path decrypts on every request — cache
  decrypted values in module scope (see the Stripe example above).
- DynamoDB: on-demand, ~$0.25/M reads + ~$1.25/M writes. The vault is
  typically read-once-per-cold-start, write-on-rotate — both negligible.
- **No per-secret monthly charge** (unlike AWS Secrets Manager which
  bills $0.40/secret/month). Storing thousands of per-user tokens here
  costs cents/month total.

## Limits + escape hatches

- **4 KB plaintext ceiling** on direct `kms:Encrypt`. Covers every API
  key / OAuth token / signing secret in practice. For larger blobs
  (e.g. a JSON service-account file > 4 KB), use `kms:GenerateDataKey`
  (already granted) + AES-256-GCM envelope encryption. Not shipped in
  v1; build it when you actually need it.
- **No bulk read API** in the public surface — by design. If a feature
  needs to iterate decrypted values server-side (rare), import
  `decryptSecret` from `vault/internal.js` for each item.
- **No CloudTrail audit log helper** in v1. KMS Decrypt calls land in
  CloudTrail automatically; if you need an in-app audit log, write a
  thin wrapper around `decryptSecret` that records `(userId, secretName,
  timestamp)` to DDB before returning.

## Why this lives in its own package

`hereya/aws-secret-vault` is a small package (one KMS key + one DDB
table + an IAM policy). It could in theory live inside
`aws-ddb-app-state`, but separating it means:

- Projects that don't need user secrets don't pay the $1/month for an
  unused KMS key.
- The RETAIN policy on this package's resources is appropriately
  scarier than the DESTROY policy on `aws-ddb-app-state`'s tables —
  losing a vault key bricks every encrypted secret.
- Future v2 features (audit log table, key rotation hooks) belong on
  the vault package without bloating the generic app-state package.
