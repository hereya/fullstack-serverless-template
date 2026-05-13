// Plain helpers used by login-only pages to send already-authenticated
// visitors back to /dashboard (or wherever ?next= points). React-free
// version of the previous useRedirectIfAuthed hook.
//
// Most of the auth-cache logic now lives in lib/authState.ts; this file
// is the thin "what does /login do with the result?" adapter.

import { getNextPath, resolveAuth, snapshot } from './authState';

export { getNextPath };

/**
 * Resolve once we know whether the visitor is already signed in.
 *   - { redirect: <path> } → caller should navigate
 *   - { ready: true }      → caller should render the login UI
 *
 * Fast path: if the shared auth cache is fresh and says `user`, returns the
 * redirect synchronously without a network round-trip.
 */
export async function resolveLoginRedirect(
  fallback = '/dashboard',
): Promise<{ redirect: string } | { ready: true }> {
  const cached = snapshot();
  if (cached.kind === 'anon') return { ready: true };
  if (cached.kind === 'user') return { redirect: getNextPath(fallback) };
  const resolved = await resolveAuth();
  if (resolved.kind === 'user') return { redirect: getNextPath(fallback) };
  // 'anon' or 'unknown' (5xx / network) — render the form. A failed /me
  // is safe to treat as "not signed in" for this gate; the worst case is
  // a logged-in user briefly sees the login form, types email, and the
  // server-side handler 200s back into a session.
  return { ready: true };
}
