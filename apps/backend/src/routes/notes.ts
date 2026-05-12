import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { getDb } from '../db/client.js';
import { dbCall } from '../db/resilience.js';
import {
  notes as notesTable,
  noteAttachments as attachmentsTable,
} from '../db/schema.js';
import {
  attachmentKey,
  deleteObject,
  presignGet,
  presignPut,
} from '../storage/s3.js';

export const notes = new Hono();

notes.use('*', authMiddleware);

const createSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(10_000).optional().default(''),
});

// 25 MB ceiling — sized for the demo Notes app (documents, screenshots,
// the occasional short clip). The underlying mechanism (presigned PUT
// direct to S3) supports much larger files: S3 single-PUT goes to 5 GB
// and the API Gateway limit is bypassed entirely. If your app actually
// needs video / large image uploads, bump this constant (and the
// matching MAX_SIZE_BYTES in apps/frontend/.../Attachments.tsx) — no
// other plumbing changes needed.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const uploadUrlSchema = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.string().min(1).max(100),
  sizeBytes: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
});

// Helper used by every attachment route: returns the note row IF the
// authenticated user owns it, else null. Avoids a `notes:read:any` style
// permission while still rejecting cross-user attempts.
async function findOwnedNote(noteId: string, userId: string) {
  const rows = await dbCall(
    () =>
      getDb()
        .select()
        .from(notesTable)
        .where(and(eq(notesTable.id, noteId), eq(notesTable.userId, userId)))
        .limit(1),
    'notes.findOwned',
  );
  return rows[0] ?? null;
}

// --------- Notes CRUD --------

notes.get('/', requirePermission(PERMISSIONS.NOTES_READ_OWN), async (c) => {
  const u = c.get('user');
  const rows = await dbCall(
    () =>
      getDb()
        .select()
        .from(notesTable)
        .where(eq(notesTable.userId, u.id))
        .orderBy(desc(notesTable.createdAt)),
    'notes.list',
  );
  return c.json(rows);
});

notes.post('/', requirePermission(PERMISSIONS.NOTES_WRITE_OWN), async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const u = c.get('user');
  const [created] = await dbCall(
    () =>
      getDb()
        .insert(notesTable)
        .values({
          userId: u.id,
          title: parsed.data.title,
          body: parsed.data.body,
        })
        .returning(),
    'notes.create',
  );
  return c.json(created, 201);
});

notes.delete(
  '/:id',
  requirePermission(PERMISSIONS.NOTES_WRITE_OWN),
  async (c) => {
    const id = c.req.param('id');
    const u = c.get('user');

    // Pull attachments first so we can also drop the S3 objects after the
    // row cascade. If the DB DELETE succeeds but the S3 cleanup fails we
    // log + continue: the database is the source of truth for "what
    // attachments still exist", and a periodic janitor would mop up the
    // orphaned objects.
    const atts = await dbCall(
      () =>
        getDb()
          .select({ s3Key: attachmentsTable.s3Key })
          .from(attachmentsTable)
          .where(
            and(
              eq(attachmentsTable.noteId, id),
              eq(attachmentsTable.userId, u.id),
            ),
          ),
      'notes.delete.findAtts',
    );

    await dbCall(
      () =>
        getDb()
          .delete(notesTable)
          .where(and(eq(notesTable.id, id), eq(notesTable.userId, u.id))),
      'notes.delete',
    );

    for (const a of atts) {
      try {
        await deleteObject(a.s3Key);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[notes.delete] failed to remove S3 object ${a.s3Key} for note ${id}`,
          err,
        );
      }
    }

    return c.json({ ok: true });
  },
);

// --------- Attachments --------

// Lists attachments for a note. Each row carries a short-lived presigned
// GET URL so the browser can download / preview without server-side
// streaming.
notes.get(
  '/:id/attachments',
  requirePermission(PERMISSIONS.NOTES_READ_OWN),
  async (c) => {
    const id = c.req.param('id');
    const u = c.get('user');
    const note = await findOwnedNote(id, u.id);
    if (!note) return c.json({ error: 'not found' }, 404);

    const rows = await dbCall(
      () =>
        getDb()
          .select()
          .from(attachmentsTable)
          .where(eq(attachmentsTable.noteId, id))
          .orderBy(desc(attachmentsTable.createdAt)),
      'attachments.list',
    );

    const out = await Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        filename: r.filename,
        contentType: r.contentType,
        sizeBytes: r.sizeBytes,
        createdAt: r.createdAt,
        downloadUrl: await presignGet(r.s3Key),
      })),
    );
    return c.json(out);
  },
);

// Initiates an attachment upload: validates ownership, inserts the row,
// returns the presigned PUT URL. The browser then PUTs the file directly
// to S3 — bypassing API Gateway's ~6 MB sync invocation limit and letting
// uploads scale to hundreds of megabytes (video, large images, etc.).
//
// We commit the row OPTIMISTICALLY rather than waiting for an upload-
// completed callback — if the user's browser closes mid-upload, the row
// will reference an S3 object that never materialized. The list endpoint
// hides that case implicitly (presignGet for a missing object returns a
// URL that 404s when fetched, which the UI surfaces as a failed
// download), and a janitor job could prune mismatched rows.
notes.post(
  '/:id/attachments/upload-url',
  requirePermission(PERMISSIONS.NOTES_WRITE_OWN),
  async (c) => {
    const id = c.req.param('id');
    const u = c.get('user');
    const note = await findOwnedNote(id, u.id);
    if (!note) return c.json({ error: 'not found' }, 404);

    const parsed = uploadUrlSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400);

    const attachmentId = crypto.randomUUID();
    const s3Key = attachmentKey({
      noteId: id,
      attachmentId,
      filename: parsed.data.filename,
    });

    const [row] = await dbCall(
      () =>
        getDb()
          .insert(attachmentsTable)
          .values({
            id: attachmentId,
            noteId: id,
            userId: u.id,
            filename: parsed.data.filename,
            s3Key,
            contentType: parsed.data.contentType,
            sizeBytes: parsed.data.sizeBytes,
          })
          .returning(),
      'attachments.create',
    );
    if (!row) {
      return c.json({ error: 'insert failed' }, 500);
    }

    const uploadUrl = await presignPut({
      key: s3Key,
      contentType: parsed.data.contentType,
      contentLength: parsed.data.sizeBytes,
    });

    return c.json(
      {
        id: row.id,
        filename: row.filename,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        createdAt: row.createdAt,
        uploadUrl,
      },
      201,
    );
  },
);

notes.delete(
  '/:id/attachments/:attId',
  requirePermission(PERMISSIONS.NOTES_WRITE_OWN),
  async (c) => {
    const id = c.req.param('id');
    const attId = c.req.param('attId');
    const u = c.get('user');

    const note = await findOwnedNote(id, u.id);
    if (!note) return c.json({ error: 'not found' }, 404);

    // Fetch s3Key before deleting the row.
    const rows = await dbCall(
      () =>
        getDb()
          .select({ s3Key: attachmentsTable.s3Key })
          .from(attachmentsTable)
          .where(
            and(
              eq(attachmentsTable.id, attId),
              eq(attachmentsTable.noteId, id),
              eq(attachmentsTable.userId, u.id),
            ),
          ),
      'attachments.lookup',
    );
    if (rows.length === 0) return c.json({ error: 'not found' }, 404);

    await dbCall(
      () =>
        getDb()
          .delete(attachmentsTable)
          .where(
            and(
              eq(attachmentsTable.id, attId),
              eq(attachmentsTable.userId, u.id),
            ),
          ),
      'attachments.delete',
    );

    try {
      await deleteObject(rows[0].s3Key);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[attachments.delete] failed to remove S3 object ${rows[0].s3Key}`,
        err,
      );
    }
    return c.json({ ok: true });
  },
);
