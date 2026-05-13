// Helpers for login-only pages (/login) that send already-authenticated
// visitors back to /dashboard (or wherever ?next= points).
//
// Split into a synchronous cache-only check and an async background
// confirmation so /login can render the form optimistically on first
// paint — see LoginForm.firstUpdated().

import { getNextPath, resolveAuth, snapshot } from './authState';

export { getNextPath };

/**
 * Synchronous cache-only verdict for /login.
 *   - `{ redirect }` if the cache says the visitor is currently signed in
 *     (state=user and the cached session expiry is still in the future).
 *   - `{ ready: true }` otherwise (anon / unknown / naturally expired) —
 *     caller should render the form immediately.
 *
 * No network round-trip. ~0.5 ms. Use this for the first-paint decision.
 */
export function loginRedirectFromCache(
  fallback = '/dashboard',
): { redirect: string } | { ready: true } {
  const cached = snapshot();
  if (cached.kind === 'user') return { redirect: getNextPath(fallback) };
  return { ready: true };
}

/**
 * Async background confirmation for /login. Hits /api/auth/me (via the
 * shared in-flight promise in authState) and returns a redirect target
 * ONLY if the server confirms the visitor is actually signed in. Returns
 * null for anon / unknown (the form is already rendered).
 *
 * The rare-but-real case this catches: visitor lands on /login with a
 * stale cache that didn't say 'user' (cache was cleared, expired, never
 * existed), but they actually have a valid session cookie. /me returns
 * 200, we redirect them away. They briefly saw the form — an acceptable
 * trade-off for not making every anon visitor wait on /me.
 */
export async function confirmLoginRedirect(
  fallback = '/dashboard',
): Promise<{ redirect: string } | null> {
  const resolved = await resolveAuth();
  if (resolved.kind === 'user') return { redirect: getNextPath(fallback) };
  return null;
}
