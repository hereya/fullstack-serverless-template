# Pattern: file attachments (S3)

Use this when a feature needs user-uploaded files — images on a profile,
PDFs attached to a note, screenshots on a bug report. The
`hereya/aws-file-storage` package is already provisioned (visible in
`hereya.yaml`); this pattern is purely code.

## Prerequisites

- The `hereya/aws-file-storage` package is in `hereya.yaml`. It exposes
  three things to the Lambda env:
  - `bucketName` — shared workspace bucket
  - `s3Prefix` — per-app prefix scoping IAM access
  - `iamPolicyAwsS3Bucket` — the bucket-scoped IAM policy (already
    attached to the Lambda execution role)
- You typically apply this alongside the [notes pattern](notes.md) —
  attachments need a parent row to attach to. The code below assumes
  notes exist; substitute your own entity.

## Storage model

Files live in S3 at keys like:

```
<s3Prefix>/notes/<noteId>/<filename>
```

Metadata (filename, content type, size, the canonical s3Key) lives in
a Postgres row. Two-phase upload to keep the Lambda off the file path:

1. **Frontend asks backend** for a presigned PUT URL.
2. **Frontend PUTs directly** to S3 with that URL.
3. **Frontend tells backend** the upload finished; backend confirms by
   HEAD-ing the object, then writes the metadata row.

Download is symmetric: backend issues a presigned GET URL; frontend
follows it.

## Steps

### 1. Re-introduce the storage helpers

```
apps/backend/src/storage/s3.ts
```

Helpers needed:

```ts
export function s3Key(parts: string[]): string {
  // Prepend the per-app prefix to every key so workspace-wide bucket
  // scans can't reach another app's objects.
  return [process.env.s3Prefix, ...parts].filter(Boolean).join('/');
}

export async function presignPut(key: string, contentType: string): Promise<string>;
export async function presignGet(key: string): Promise<string>;
export async function headObject(key: string): Promise<{ size: number; contentType: string } | null>;
export async function deleteObject(key: string): Promise<void>;
```

Use `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`. Add deps:

```jsonc
"dependencies": {
  "@aws-sdk/client-s3": "^3.1045.0",
  "@aws-sdk/s3-request-presigner": "^3.1045.0",
  // …existing
}
```

### 2. Add the metadata table to Drizzle

Assumes you've already applied the [notes pattern](notes.md) (you have
Drizzle + Aurora running). In `src/db/schema.ts`:

```ts
export const noteAttachments = pgTable('note_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  noteId: uuid('note_id')
    .notNull()
    .references(() => notes.id, { onDelete: 'cascade' }),
  // Denormalized off notes.user_id so per-row authz doesn't need a join.
  userId: uuid('user_id').notNull(),
  filename: text('filename').notNull(),
  s3Key: text('s3_key').notNull().unique(),
  contentType: text('content_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});
```

Run `npm run db:generate` and commit the new SQL.

### 3. Add env-var entries

In `src/env.ts`:

```ts
const schema = z.object({
  // …existing
  bucketName: z.string().min(1),
  s3Prefix: z.string().min(1).optional(),
});
```

### 4. Add backend routes

```
apps/backend/src/routes/attachments.ts    ← mounted under /api/notes/:id/attachments
```

Three endpoints:

- `POST   /api/notes/:noteId/attachments`   — issues a presigned PUT URL
- `GET    /api/notes/:noteId/attachments`   — lists current attachments
- `DELETE /api/notes/:noteId/attachments/:id` — removes both the S3 object and the metadata row

Each route MUST verify the authenticated user owns the parent note.

Wire under `app.ts`:

```ts
app.route('/api/notes', notes);
// attachments are mounted INSIDE the notes route in src/routes/notes.ts
// so the :noteId param is in scope.
```

### 5. Cascade cleanup

When a note is deleted:
1. Look up all `note_attachments` rows for that note.
2. `deleteObject` for each `s3Key`.
3. Drizzle's `CASCADE` on `noteId` cleans up the metadata rows
   automatically — but the S3 objects are NOT cleaned up by the
   database FK, so the manual loop in step 2 is required.

Wrap this in the same transaction guard as note deletion.

### 6. Frontend

Add `src/components/Attachments.ts` (Lit island showing the
upload-button + attachment list). Hosts inside the notes-page UI.

Upload flow in the island:

```ts
// 1. Ask backend for a URL
const { uploadUrl, s3Key } = await api(`/api/notes/${noteId}/attachments`, {
  method: 'POST',
  body: JSON.stringify({ filename, contentType }),
});
// 2. PUT directly to S3
await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': contentType } });
// 3. Tell backend the upload finished (backend HEADs the object,
//    writes the metadata row, returns the persisted attachment).
const att = await api(`/api/notes/${noteId}/attachments/confirm`, {
  method: 'POST',
  body: JSON.stringify({ s3Key }),
});
```

### 7. MCP tools (optional)

If you want agents to attach files via Claude, add
`src/mcp/tools/attachments.ts` with `attachments_list` /
`attachments_delete` tools. Don't expose an `attachments_create` tool —
direct S3 PUT from an MCP client is awkward and not worth the
complexity. Agents that need to upload should call a regular API.

### 8. Tests (drop into `apps/backend/tests/attachments.test.ts` when wiring the pattern)

This file isn't shipped by the minimal template because the routes it
exercises don't exist until you apply this pattern. Paste it as
`apps/backend/tests/attachments.test.ts` after step 4 lands, and it
covers the per-route ownership / presign / cleanup expectations:

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
process.env.bucketName = 'fake-bucket';
process.env.s3Prefix = 'test-app';
process.env.AWS_REGION = 'us-east-1';

// ------- Session + auth mocks -------
const sessionsSpies = {
  getSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  deleteUserSessions: vi.fn(),
};
vi.mock('../src/auth/sessions.js', () => ({
  getSession: (...a: unknown[]) => sessionsSpies.getSession(...a),
  createSession: (...a: unknown[]) => sessionsSpies.createSession(...a),
  deleteSession: (...a: unknown[]) => sessionsSpies.deleteSession(...a),
  deleteUserSessions: (...a: unknown[]) =>
    sessionsSpies.deleteUserSessions(...a),
}));

vi.mock('../src/auth/cognito.js', () => ({
  ensureUser: vi.fn(),
  startCustomAuth: vi.fn(),
  respondToCustomChallenge: vi.fn(),
  refreshTokens: vi
    .fn()
    .mockResolvedValue({ accessToken: 'at', expiresIn: 3600 }),
  getCognito: vi.fn(),
}));

vi.mock('../src/auth/users.js', () => ({
  findUserById: vi.fn(),
  findUserByEmail: vi.fn(),
  addAllowlistedUser: vi.fn(),
  listUsers: vi.fn(),
  setSuspended: vi.fn(),
  countActiveAdmins: vi.fn(),
  countUsers: vi.fn(),
  createFirstAdmin: vi.fn(),
  linkCognitoSub: vi.fn(),
  bootstrapComplete: vi.fn(),
}));

vi.mock('../src/auth/permissions.js', () => ({
  PERMISSIONS: {
    USERS_LIST: 'users:list',
    USERS_ADD: 'users:add',
    USERS_SUSPEND: 'users:suspend',
    NOTES_READ_OWN: 'notes:read:own',
    NOTES_WRITE_OWN: 'notes:write:own',
  },
  ALL_PERMISSIONS: [],
  MEMBER_PERMISSIONS: [],
  roleHasPermission: async (roleName: string, perm: string) => {
    if (roleName === 'admin') return true;
    if (roleName === 'member') {
      return perm === 'notes:read:own' || perm === 'notes:write:own';
    }
    return false;
  },
  invalidateRoleCache: () => undefined,
}));

vi.mock('../src/email/postmark.js', () => ({ sendOtp: vi.fn() }));

// ------- S3 + presigner mocks -------
const s3Send = vi.fn().mockResolvedValue({});
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(cmd: unknown): Promise<unknown> { return s3Send(cmd); } }
  class PutObjectCommand { input: unknown; constructor(i: unknown) { this.input = i; } }
  class GetObjectCommand { input: unknown; constructor(i: unknown) { this.input = i; } }
  class DeleteObjectCommand { input: unknown; constructor(i: unknown) { this.input = i; } }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
});

const presigner = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => presigner(...args),
}));

// ------- Drizzle / DB mock -------
const db = {
  selectQueue: [] as unknown[][],
  insertRows: [] as unknown[],
  deleteCalls: 0,
};

vi.mock('../src/db/resilience.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db/resilience.js')>(
    '../src/db/resilience.js',
  );
  return { ...actual, warmupCluster: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../src/db/client.js', () => {
  const buildAwaitableQuery = () => {
    let cached: Promise<unknown[]> | null = null;
    const resolve = () => {
      if (!cached) cached = Promise.resolve(db.selectQueue.shift() ?? []);
      return cached;
    };
    return {
      limit: resolve,
      orderBy: resolve,
      then: (onF: (r: unknown[]) => unknown, onR?: (e: unknown) => unknown) =>
        resolve().then(onF, onR),
      catch: (onR: (e: unknown) => unknown) => resolve().catch(onR),
      finally: (onF: () => void) => resolve().finally(onF),
    };
  };
  const selectChain = () => ({
    from: () => ({
      where: buildAwaitableQuery,
      orderBy: () => Promise.resolve(db.selectQueue.shift() ?? []),
    }),
  });
  return {
    getDb: () => ({
      select: () => selectChain(),
      insert: () => ({
        values: () => ({ returning: () => Promise.resolve(db.insertRows) }),
      }),
      delete: () => ({
        where: () => { db.deleteCalls += 1; return Promise.resolve(); },
      }),
    }),
  };
});

vi.mock('../src/db/schema.js', () => ({
  users: {},
  notes: { id: 'id', userId: 'user_id' },
  noteAttachments: {
    id: 'id', noteId: 'note_id', userId: 'user_id',
    s3Key: 's3_key', createdAt: 'created_at',
  },
}));

function asMember() {
  sessionsSpies.getSession.mockResolvedValue({
    sessionId: 'sid', userId: 'u-member', email: 'member@example.test',
    roleName: 'member', refreshToken: 'rt',
  });
}
function cookie() { return { cookie: 'hereya_sid=sid' }; }
const ownedNote = [{ id: 'n1', userId: 'u-member' }];

import { app } from '../src/app.js';

describe('note attachments', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    s3Send.mockReset(); s3Send.mockResolvedValue({});
    presigner.mockReset(); presigner.mockResolvedValue('https://signed.example/aws-url');
    sessionsSpies.getSession.mockReset();
    db.selectQueue = []; db.insertRows = []; db.deleteCalls = 0;
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('GET /api/notes/:id/attachments → 404 when the note does not belong to the caller', async () => {
    asMember();
    db.selectQueue = [[]]; // findOwnedNote → no rows
    const res = await app.request('/api/notes/n1/attachments', { headers: cookie() });
    expect(res.status).toBe(404);
  });

  it('GET /api/notes/:id/attachments returns the rows with a presigned downloadUrl each', async () => {
    asMember();
    db.selectQueue = [
      ownedNote,
      [{
        id: 'a1', filename: 'one.txt', contentType: 'text/plain',
        sizeBytes: 10, createdAt: new Date('2025-01-01'),
        s3Key: 'notes/n1/a1/one.txt',
      }],
    ];
    const res = await app.request('/api/notes/n1/attachments', { headers: cookie() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]?.filename).toBe('one.txt');
    expect(body[0]?.downloadUrl).toBe('https://signed.example/aws-url');
    expect(presigner).toHaveBeenCalledTimes(1);
  });

  it('POST /api/notes/:id/attachments/upload-url returns 400 on missing fields', async () => {
    asMember();
    db.selectQueue = [ownedNote];
    const res = await app.request('/api/notes/n1/attachments/upload-url', {
      method: 'POST',
      headers: { ...cookie(), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/notes/:id/attachments/upload-url rejects files > 25 MB', async () => {
    asMember();
    db.selectQueue = [ownedNote];
    const res = await app.request('/api/notes/n1/attachments/upload-url', {
      method: 'POST',
      headers: { ...cookie(), 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'huge.bin', contentType: 'application/octet-stream',
        sizeBytes: 26 * 1024 * 1024,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/notes/:id/attachments/upload-url inserts a row and returns a presigned PUT URL', async () => {
    asMember();
    db.selectQueue = [ownedNote];
    db.insertRows = [{
      id: 'a-new', filename: 'photo.jpg', contentType: 'image/jpeg',
      sizeBytes: 1234, createdAt: new Date('2025-01-01'),
      s3Key: 'notes/n1/a-new/photo.jpg',
    }];
    const res = await app.request('/api/notes/n1/attachments/upload-url', {
      method: 'POST',
      headers: { ...cookie(), 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'photo.jpg', contentType: 'image/jpeg', sizeBytes: 1234,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.uploadUrl).toBe('https://signed.example/aws-url');
    expect(body.filename).toBe('photo.jpg');
    expect(presigner).toHaveBeenCalledTimes(1);
  });

  it('DELETE /api/notes/:id/attachments/:attId removes the row and the S3 object', async () => {
    asMember();
    db.selectQueue = [
      ownedNote,
      [{ s3Key: 'notes/n1/a-existing/file.txt' }],
    ];
    const res = await app.request('/api/notes/n1/attachments/a-existing', {
      method: 'DELETE',
      headers: cookie(),
    });
    expect(res.status).toBe(200);
    expect(db.deleteCalls).toBeGreaterThanOrEqual(1);
    expect(s3Send).toHaveBeenCalledTimes(1);
  });
});
```

## What to think about

- **Content-type spoofing.** A malicious client can claim
  `image/png` and upload an HTML file. Either:
  - Re-derive content-type server-side from the file extension, OR
  - Set the bucket policy to force `Content-Disposition: attachment`
    on download (S3 supports this via presigned URL params).
- **Max size.** Set a Content-Length-Range condition on the presigned
  URL so users can't upload 5GB files. 10MB is a sensible cap for most
  apps.
- **Public vs. private.** The default `aws-file-storage` bucket is
  PRIVATE — every read needs a presigned GET. If you want public-image
  assets (avatars, etc.), use a separate public bucket; don't make this
  one public.
- **Orphan cleanup.** If step 2 of the upload fails (S3 PUT errors)
  and the client never calls step 3, you have a presigned-URL slot
  that wasted bandwidth and no metadata. That's tolerable — S3
  lifecycle rules can sweep orphan keys older than N days.
