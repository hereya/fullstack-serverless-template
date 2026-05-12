import type { Context, Next } from 'hono';

// Runs AFTER authMiddleware. c.get('user') is guaranteed to be set with role.
export async function requireAdmin(c: Context, next: Next): Promise<Response | void> {
  const u = c.get('user');
  if (!u || u.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  await next();
}
