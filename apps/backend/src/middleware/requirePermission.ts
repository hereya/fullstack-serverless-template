import type { Context, MiddlewareHandler, Next } from 'hono';
import {
  roleHasPermission,
  type Permission,
} from '../auth/permissions.js';

// Runs AFTER authMiddleware. c.get('user') is set with roleName. Returns
// 403 if the user's role does not include the requested permission (or if
// the role itself doesn't exist in authRolesTable).
//
// Permission lookup hits the in-memory role cache in auth/permissions.ts —
// a ~5ms DDB Get at worst, once per Lambda warm lifetime per role per 60s.
export function requirePermission(perm: Permission): MiddlewareHandler {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const u = c.get('user');
    if (!u) return c.json({ error: 'unauthenticated' }, 401);
    const ok = await roleHasPermission(u.roleName, perm);
    if (!ok) return c.json({ error: 'forbidden' }, 403);
    await next();
  };
}
