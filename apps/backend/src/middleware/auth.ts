import type { Context, Next } from 'hono';
import { getCookie, deleteCookie } from 'hono/cookie';
import { jwtDecode } from 'jwt-decode';
import { getSession, deleteSession } from '../auth/sessions.js';
import { refreshTokens } from '../auth/cognito.js';

interface AccessTokenCache {
  accessToken: string;
  expiresAt: number;
}

// In-memory cache keyed by sessionId. Valid only for the Lambda warm lifetime.
const accessTokenCache = new Map<string, AccessTokenCache>();

export interface AuthUser {
  id: string;
  sub: string | null;
  email: string;
  roleName: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser;
    sessionId: string;
  }
}

function isExpired(c: AccessTokenCache): boolean {
  return c.expiresAt < Date.now() + 30_000;
}

async function clear(c: Context, sessionId: string): Promise<void> {
  try {
    await deleteSession(sessionId);
  } catch {
    // best-effort
  }
  accessTokenCache.delete(sessionId);
  deleteCookie(c, 'hereya_sid', { path: '/' });
}

// Hot-path auth: zero Aurora calls, zero authUsersTable calls.
//
// All identity + authz state needed for routing decisions lives on the
// DDB session row (snapshotted at login):
//   { sessionId, userId, email, roleName, refreshToken, ttl }
//
// Suspended users have their sessions deleted by the admin action that
// suspended them, so authMiddleware never resolves them past the
// GetSession call.
//
// Permission checks happen downstream in requirePermission, which looks
// up the role's permission set from authRolesTable (cached ~60s).
export async function authMiddleware(c: Context, next: Next) {
  const sessionId = getCookie(c, 'hereya_sid');
  if (!sessionId) {
    return c.json({ error: 'unauthenticated' }, 401);
  }

  const session = await getSession(sessionId);
  if (!session) {
    deleteCookie(c, 'hereya_sid', { path: '/' });
    return c.json({ error: 'unauthenticated' }, 401);
  }

  // Refresh the Cognito access token if missing or expired. Failures here
  // mean the refresh-token is dead — clear everything and 401.
  let cached = accessTokenCache.get(sessionId);
  if (!cached || isExpired(cached)) {
    try {
      const { accessToken, expiresIn } = await refreshTokens(
        session.refreshToken,
      );
      cached = { accessToken, expiresAt: Date.now() + expiresIn * 1000 };
      accessTokenCache.set(sessionId, cached);
    } catch {
      await clear(c, sessionId);
      return c.json({ error: 'unauthenticated' }, 401);
    }
  }

  // Pull cognito sub out of the access token for downstream code that wants it.
  let sub: string | null = null;
  try {
    const decoded = jwtDecode<{ sub: string }>(cached.accessToken);
    if (decoded.sub) sub = decoded.sub;
  } catch {
    // fall through with null
  }

  c.set('user', {
    id: session.userId,
    sub,
    email: session.email,
    roleName: session.roleName,
  });
  c.set('sessionId', sessionId);
  await next();
}
