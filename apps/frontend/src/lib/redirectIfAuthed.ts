// Plain helpers used by login-only pages to send already-authenticated
// visitors back to /dashboard (or wherever ?next= points). React-free
// version of the previous useRedirectIfAuthed hook.

import { api } from './api';

const CACHE_KEY = 'hereya_authnav_v1';

interface CacheShape {
  state: 'anon' | 'user';
}

function readCacheState(): 'anon' | 'user' | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheShape;
    return parsed.state === 'user' ? 'user' : 'anon';
  } catch {
    return null;
  }
}

// Reads `?next=` off the current URL. Only accepts paths that start with
// `/` (and not `//`) to avoid open-redirect-style abuse where someone
// crafts a URL like `/login?next=https://attacker.com`.
export function getNextPath(fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  try {
    const next = new URLSearchParams(window.location.search).get('next');
    if (next && next.startsWith('/') && !next.startsWith('//')) return next;
  } catch {
    // ignore
  }
  return fallback;
}

/**
 * Resolve once we know whether the visitor is already signed in.
 *   - { redirect: <path> } → caller should navigate
 *   - { ready: true }      → caller should render the login UI
 *
 * Fast path: if the AuthNav cache is fresh and says `user`, returns the
 * redirect synchronously without a network round-trip.
 */
export async function resolveLoginRedirect(
  fallback = '/dashboard',
): Promise<{ redirect: string } | { ready: true }> {
  const cached = readCacheState();
  if (cached === 'anon') return { ready: true };
  if (cached === 'user') return { redirect: getNextPath(fallback) };
  try {
    await api('/api/auth/me');
    return { redirect: getNextPath(fallback) };
  } catch {
    // 401 / network / other — visitor is anon, render the form.
    return { ready: true };
  }
}
