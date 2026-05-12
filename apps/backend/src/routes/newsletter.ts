import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { dbCall } from '../db/resilience.js';
import { newsletterSubscriptions } from '../db/schema.js';

// Public form example. No auth. Demonstrates the static-only path of the
// template — a marketing landing page can collect emails without any of the
// Cognito / users-table machinery being involved.

export const newsletter = new Hono();

const schema = z.object({ email: z.string().email() });

newsletter.post('/', async (c) => {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid email' }, 400);

  // Idempotent: same email twice still returns 200, but we never reveal
  // whether the email was already subscribed (avoids enumeration).
  await dbCall(
    () =>
      getDb()
        .insert(newsletterSubscriptions)
        .values({ email: parsed.data.email })
        .onConflictDoNothing(),
    'newsletter.subscribe',
  );

  return c.json({ ok: true });
});
