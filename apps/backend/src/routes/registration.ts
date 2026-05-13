// Public registration form route. Captures email + optional name (or any
// additional custom fields the project's form sends) and stores in DDB
// via auth/registrationsStore.ts. No auth — anonymous visitors POST here.
//
// Replaces the previous /api/newsletter route which used Aurora. DDB
// removes the cold-start latency on the public form path.
//
// The admin surface (list / delete) lives in routes/admin.ts under
// /api/admin/registrations and reuses the same store.

import { Hono } from 'hono';
import { z } from 'zod';
import { addRegistration } from '../auth/registrationsStore.js';

export const registration = new Hono();

// Minimal schema: email is required, name is optional. Extra fields
// arrive through `.passthrough()` so a project's form can add arbitrary
// extra captures (company, referrer, custom checkbox state, etc.)
// without needing to amend this schema — the store accepts them as
// schema-less attributes on the DDB item.
const schema = z
  .object({
    email: z.string().email(),
    name: z.string().max(200).optional(),
  })
  .passthrough();

registration.post('/', async (c) => {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid email' }, 400);

  const { email, ...extra } = parsed.data;
  // Idempotent: same email twice still returns 200, never reveals
  // whether the email was already registered (avoids enumeration).
  await addRegistration(email, extra);

  return c.json({ ok: true });
});
