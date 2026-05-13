// Centralized client-side auth state.
//
// Why this exists: several islands need to know "is the current visitor
// signed in, and as what role?" — AuthNav (whole-site header), the admin
// shell tabs, every /admin/* data island, and the /login redirect-if-authed
// helper. Without a shared module each one reimplements the sessionStorage
// cache or — worse — does its own /api/auth/me round-trip and races the
// others. The cost of getting it wrong is visible: stale anon nav above
// authed content, or a flash of the admin menu while the page is about
// to redirect to /login.
//
// Cheap reads + one shared probe:
//   snapshot()      — synchronous cache read, returns 'unknown' if nothing
//                     fresh is cached. Use in component constructors so the
//                     first paint already reflects the right state.
//   resolveAuth()   — async, shared in-flight promise. Hits /api/auth/me
//                     exactly once even if four components mount on the
//                     same page and all call resolveAuth in parallel. The
//                     /me endpoint is fast: with no `hereya_sid` cookie,
//                     the backend returns 401 before touching any DB; with
//                     a cookie it's a single DynamoDB GetItem (no Aurora).
//   requireAdmin()  — combined helper for /admin/* pages. If the user is
//                     anonymous, redirects to /login?next=... immediately
//                     (no menu flash). Otherwise returns the snapshot so
//                     the caller can branch on `forbidden` vs `ready`.
//
// The "DB cold-start" problem this solves: the project's Aurora cluster
// pauses when idle and takes ~5s to warm. Previously each /admin/* page
// kicked off its data fetch (touches Aurora) AND showed the tabs/skeleton
// the moment it hydrated — so an anonymous visitor saw the admin menu for
// the full Aurora wake-up window before the eventual 401 redirected them.
// Resolving auth via /me first (DDB-only, never blocked by Aurora) means
// the redirect decision lands in ms, not seconds.

import { api } from './api';

export interface Me {
  id: string;
  email: string;
  roleName: string;
}

export type AuthSnapshot =
  | { kind: 'unknown' } // never checked, no fresh cache
  | { kind: 'anon' }
  | { kind: 'user'; user: Me };

const CACHE_KEY = 'hereya_authnav_v1';
// 5 minutes — long enough that ordinary click-around navigation never
// re-fetches /me, short enough that a server-side suspension takes effect
// within a few minutes. Errored fetches don't poison the cache (see
// resolveAuth below), so a transient 5xx during cold-start won't strand
// the user as "anon" until TTL expires.
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheShape {
  state: 'anon' | 'user';
  user?: Me;
  fetchedAt: number;
}

function readCache(): CacheShape | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheShape;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(c: CacheShape): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    // sessionStorage unavailable (private mode) — degrades to a re-fetch
    // on the next mount.
  }
}

export function clearAuthCache(): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}

// Cross-tab auth-state signal. The cache itself is per-tab (sessionStorage,
// intentional — don't share user data across windows); a timestamped bump
// in localStorage lets sibling tabs notice a login/logout and re-fetch /me.
// localStorage 'storage' events fire in OTHER tabs only — not the writer —
// which is exactly what we want here.
const SYNC_KEY = 'hereya_auth_sync_v1';

export function bumpAuthSync(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SYNC_KEY, String(Date.now()));
  } catch {
    // private mode — cross-tab sync degrades, the TTL self-heals
  }
}

export function onAuthSync(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: StorageEvent) => {
    if (e.key === SYNC_KEY) handler();
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}

// Synchronous cache read. Returns 'unknown' when nothing is cached fresh.
// Use this in component constructors so the FIRST paint already reflects
// the user's known state — no loading-flash on repeat visits.
export function snapshot(): AuthSnapshot {
  const cached = readCache();
  if (!cached) return { kind: 'unknown' };
  if (cached.state === 'user' && cached.user) {
    return { kind: 'user', user: cached.user };
  }
  return { kind: 'anon' };
}

// In-flight /me promise shared across all callers in the same tick. Cleared
// when settled so a later call after cache expiry can re-fetch.
let inFlight: Promise<AuthSnapshot> | null = null;

// Async resolve. Returns a settled snapshot ('user', 'anon', or 'unknown'
// if the call failed in a way we don't want to cache — e.g. 5xx / network).
// Multiple concurrent callers share one /me request.
export function resolveAuth(): Promise<AuthSnapshot> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const me = await api<Me>('/api/auth/me');
      writeCache({ state: 'user', user: me, fetchedAt: Date.now() });
      return { kind: 'user', user: me } as AuthSnapshot;
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.startsWith('401')) {
        writeCache({ state: 'anon', fetchedAt: Date.now() });
        return { kind: 'anon' } as AuthSnapshot;
      }
      // 5xx / network / unknown — don't persist a verdict. Next mount will
      // re-fetch instead of inheriting a wrong "anon" for the full TTL.
      // (See the AuthNav comment block in the previous implementation for
      // the cold-start /me-fails-once trace this defends against.)
      return { kind: 'unknown' } as AuthSnapshot;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// `?next=` extractor used by login/admin redirects. Only accepts paths that
// start with `/` (and not `//`) to avoid open-redirect-style abuse where a
// crafted query like `?next=https://attacker.com` would otherwise bounce
// the user off-site after login.
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

// Convenience for /admin/* pages. Returns the resolved snapshot. If anon,
// fires a redirect to /login?next=<currentPath> before returning so the
// caller can also abort (it returns the 'anon' snapshot regardless — the
// navigation is racing the rest of the JS turn).
export async function requireAdmin(
  currentPath: string,
): Promise<AuthSnapshot> {
  let snap = snapshot();
  if (snap.kind === 'unknown') {
    snap = await resolveAuth();
  }
  if (snap.kind === 'anon') {
    if (typeof window !== 'undefined') {
      window.location.replace(
        `/login?next=${encodeURIComponent(currentPath)}`,
      );
    }
  }
  return snap;
}

// Test-only / logout helper to write a known state. Exposed because
// AuthNav.logout() needs to populate 'anon' after a successful POST.
export function setAnon(): void {
  writeCache({ state: 'anon', fetchedAt: Date.now() });
}
