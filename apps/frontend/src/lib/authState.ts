// Centralized client-side auth state — the durable cache version.
//
// Storage model:
//   - localStorage (NOT sessionStorage): persists across tabs and browser
//     restarts. A user who has authenticated once gets an instant verdict
//     on every subsequent navigation — even from a new tab.
//   - Verdict validity is tied to the server-side session TTL: each /me
//     response carries `sessionExpiresAt` (Unix seconds — straight off
//     the DDB session row's TTL field). snapshot() reads it synchronously
//     and treats `now >= expiresAt` as "anon" (the server session has
//     naturally expired). No client-side TTL guesswork; the client only
//     trusts the verdict for as long as the server-issued lifetime says.
//
// What this protects against:
//   - Aurora cold-start latency on /admin/* — irrelevant; /me doesn't
//     touch Aurora and admin verdicts are cache-resolved.
//   - Lambda cold-start latency on /me — also irrelevant in the steady
//     state; only the FIRST visit ever requires a /me, after which the
//     verdict is durable for ~30 days.
//   - Natural session expiry — handled by the expiresAt check, no flash.
//
// What this does NOT protect against (still requires server confirmation):
//   - Server-side early deletion (admin suspends user, role change,
//     logout from another device). These produce a brief admin-chrome
//     flash on the next /admin/* visit, after which the background /me
//     or data-fetch 401 clears the cache and redirects. Rare events.
//
// Cache invalidation signals:
//   1. AuthNav.logout() → clearAuthCache() + bumpAuthSync()
//   2. snapshot() observing `now >= expiresAt` → returns 'anon' (the
//      stale row is left in place for diagnostics; the next write
//      overwrites it)
//   3. Any 401 from any authed API call → api.ts calls clearAuthCache()
//   4. Background /me 401 → resolveAuth() writes a fresh 'anon' verdict
//      so future synchronous reads land instantly on 'anon'

import { api } from './api';

export interface Me {
  id: string;
  email: string;
  roleName: string;
  // Unix seconds. Exposed by /api/auth/me; we cache it so the
  // synchronous gate can decide "has this session naturally expired?"
  // without any network round-trip.
  sessionExpiresAt: number;
}

export type AuthSnapshot =
  | { kind: 'unknown' } // never checked, no cache
  | { kind: 'anon' }
  | { kind: 'user'; user: Me };

const CACHE_KEY = 'hereya_authnav_v1';

interface CacheShape {
  state: 'anon' | 'user';
  user?: Me;
  // Unix seconds. Only meaningful when state === 'user' — for 'anon'
  // we keep the row indefinitely (cheap, no PII).
  expiresAt?: number;
  fetchedAt: number; // kept for diagnostics only; no longer drives TTL
}

function readCache(): CacheShape | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CacheShape;
  } catch {
    return null;
  }
}

function writeCache(c: CacheShape): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    // localStorage unavailable (private mode / quota) — degrades to a
    // re-fetch on the next mount. No fatal path.
  }
}

export function clearAuthCache(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}

// Cross-tab auth-state signal. The cache itself lives in localStorage now
// (so siblings see writes directly), but we still bump a separate key on
// login/logout so other tabs get a notification to re-read state. The
// `storage` event fires in OTHER tabs only — not the writer — which is
// exactly what we want here.
const SYNC_KEY = 'hereya_auth_sync_v1';

export function bumpAuthSync(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SYNC_KEY, String(Date.now()));
  } catch {
    // private mode — cross-tab sync degrades; the next /me self-heals
  }
}

export function onAuthSync(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: StorageEvent) => {
    if (e.key === SYNC_KEY || e.key === CACHE_KEY) handler();
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}

// Synchronous cache read. Returns 'unknown' when nothing is cached, and
// 'anon' when the cached 'user' has naturally expired (so callers don't
// have to repeat the expiry check). Use this in component constructors
// and inline <script> gates so first paint already reflects the verdict.
export function snapshot(): AuthSnapshot {
  const cached = readCache();
  if (!cached) return { kind: 'unknown' };
  if (cached.state === 'user' && cached.user) {
    if (
      typeof cached.expiresAt === 'number' &&
      Date.now() / 1000 < cached.expiresAt
    ) {
      return { kind: 'user', user: cached.user };
    }
    // Cached as user but expired (or missing expiry). Treat as anon
    // for the synchronous decision; resolveAuth() will eventually
    // overwrite the row.
    return { kind: 'anon' };
  }
  return { kind: 'anon' };
}

// In-flight /me promise shared across all callers in the same tick.
// Cleared when settled so a later call after invalidation can re-fetch.
let inFlight: Promise<AuthSnapshot> | null = null;

// Async resolve. Hits /api/auth/me exactly once even if multiple components
// call it in parallel. Writes the response (or a fresh anon verdict on 401)
// to the cache so the next synchronous read lands instantly.
export function resolveAuth(): Promise<AuthSnapshot> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const me = await api<Me>('/api/auth/me');
      writeCache({
        state: 'user',
        user: me,
        expiresAt: me.sessionExpiresAt,
        fetchedAt: Date.now(),
      });
      return { kind: 'user', user: me } as AuthSnapshot;
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.startsWith('401')) {
        writeCache({ state: 'anon', fetchedAt: Date.now() });
        return { kind: 'anon' } as AuthSnapshot;
      }
      // 5xx / network / unknown — don't persist a verdict. Next mount
      // will re-fetch instead of inheriting a wrong "anon" verdict.
      return { kind: 'unknown' } as AuthSnapshot;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// Imperative writes — used by AuthNav.logout (setAnon) and the post-login
// path when the caller wants the cache to be fresh immediately rather
// than relying on the next /me round-trip.
export function setUser(me: Me): void {
  writeCache({
    state: 'user',
    user: me,
    expiresAt: me.sessionExpiresAt,
    fetchedAt: Date.now(),
  });
}

export function setAnon(): void {
  writeCache({ state: 'anon', fetchedAt: Date.now() });
}

// `?next=` extractor used by login/admin redirects. Only accepts paths
// that start with `/` (and not `//`) to avoid open-redirect-style abuse
// where a crafted query like `?next=https://attacker.com` would otherwise
// bounce the user off-site after login.
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
//
// In the steady-state, the /admin/* inline <script> gate already
// redirects anon visitors before the islands even hydrate; this helper
// is the island-level safety net for the rare case where the cache says
// 'user' but the background /me returns 401 (server-side early deletion).
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
