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
