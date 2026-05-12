import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { api } from '../lib/api';

type Status = 'loading' | 'anon' | 'user';

interface Me {
  id: string;
  email: string;
  roleName: string;
}

interface CacheShape {
  state: 'anon' | 'user';
  user?: Me;
  fetchedAt: number;
}

const CACHE_KEY = 'hereya_authnav_v1';
// 5 minutes — covers normal click-around navigation without re-fetching,
// while still short enough that a server-side suspension takes effect
// within a few minutes even if the user never makes a 4xx-producing call
// in between. 4xx responses additionally clear the cache eagerly via
// `clearAuthNavCache` (see lib/api.ts).
const CACHE_TTL_MS = 5 * 60 * 1000;

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
    // sessionStorage may be unavailable (private mode); fall through silently
  }
}

function clearCache(): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}

// Cross-tab auth-state signal. The cache itself lives in sessionStorage
// (per-tab, intentional — don't share user data across windows), but a
// timestamped "bump" in localStorage lets other tabs notice that auth
// state just changed (login or logout) and re-fetch /me. localStorage
// writes fire the `storage` event in every OTHER tab on the same origin;
// they don't fire in the writing tab itself, which is exactly what we
// want here.
const SYNC_KEY = 'hereya_auth_sync_v1';

function bumpSync(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SYNC_KEY, String(Date.now()));
  } catch {
    // localStorage may be unavailable (private mode); cross-tab sync
    // degrades gracefully — the 5-min TTL still self-heals.
  }
}

const linkBase =
  'rounded px-2 py-1 text-sm font-medium transition-colors hover:bg-neutral-100';

@customElement('hy-auth-nav')
export class HyAuthNav extends LitElement {
  createRenderRoot() {
    return this;
  }

  // Initial state is read SYNCHRONOUSLY from sessionStorage in the
  // constructor below, BEFORE Lit's first render. Doing this in
  // firstUpdated() (which fires after the first paint) was the cause
  // of a visible flicker on every page navigation: paint #1 showed the
  // 3-link "loading" nav, paint #2 added Dashboard/Admin/email/Logout.
  // With the cache consulted in the constructor, the first paint is
  // already the cached terminal state — no flicker for repeat visitors.
  @state() private status: Status = 'loading';
  @state() private user: Me | null = null;

  // Tracks whether we already filled state from the cache, so
  // firstUpdated knows whether to skip the network fetch.
  private hadCache = false;

  private cancelled = false;
  private syncListener: ((e: StorageEvent) => void) | null = null;

  constructor() {
    super();
    const cached = readCache();
    if (cached?.state === 'user' && cached.user) {
      this.status = 'user';
      this.user = cached.user;
      this.hadCache = true;
    } else if (cached?.state === 'anon') {
      this.status = 'anon';
      this.hadCache = true;
    }
    // else: stay at 'loading'; firstUpdated will fetch /me.
  }

  firstUpdated() {
    if (!this.hadCache) {
      // No fresh cache — confirm with the server. (If the cache was
      // populated, the constructor already filled `status`/`user` and
      // we trust it for the cache's 5-min TTL.)
      void this.refresh();
    }

    // Cross-tab sync: a sibling tab logging in/out bumps SYNC_KEY; we
    // drop our cache and re-fetch so the nav reflects the new state
    // within ms rather than waiting for the 5-min TTL. The `storage`
    // event only fires in OTHER tabs (not the one that wrote), which is
    // why this listener doesn't loop with our own bumpSync() calls.
    if (typeof window !== 'undefined') {
      this.syncListener = (e: StorageEvent) => {
        if (e.key === SYNC_KEY) {
          clearCache();
          void this.refresh();
        }
      };
      window.addEventListener('storage', this.syncListener);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.cancelled = true;
    if (this.syncListener && typeof window !== 'undefined') {
      window.removeEventListener('storage', this.syncListener);
      this.syncListener = null;
    }
  }

  private async refresh() {
    try {
      const me = await api<Me>('/api/auth/me');
      if (this.cancelled) return;
      this.user = me;
      this.status = 'user';
      writeCache({ state: 'user', user: me, fetchedAt: Date.now() });
    } catch (err) {
      // Visually fall back to anon so the loading state doesn't linger…
      if (this.cancelled) return;
      this.user = null;
      this.status = 'anon';
      // …but only PERSIST that conclusion to the cache if the server
      // actually told us we're not logged in (401). Cold starts, 5xx,
      // network blips, etc. leave the cache empty so the next mount
      // retries instead of inheriting a wrong "anon" verdict for the
      // full TTL — that's the scenario where a freshly-deployed Lambda
      // cold-starts on /me, the nav silently goes anon for 5 minutes,
      // and the dashboard (warm Lambda by then) shows authed content
      // beneath an anon nav. See AuthNav comment block for the trace.
      const msg = err instanceof Error ? err.message : '';
      if (msg.startsWith('401')) {
        writeCache({ state: 'anon', fetchedAt: Date.now() });
      }
    }
  }

  private async logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // best-effort
    }
    clearCache();
    bumpSync(); // tell sibling tabs to drop their cache + re-fetch
    window.location.href = '/';
  }

  // Three nav states, chosen so the user never sees information change:
  //
  //   loading → only the public links (Home / About / Subscribe). Auth-
  //             dependent elements are absent. Renders briefly only for
  //             truly fresh visitors (no cache) or after a 5-min idle gap.
  //   anon    → public links + Login.
  //   user    → public links + Dashboard + [Admin] + email + Logout.
  //
  // Because "loading" is a subset of both terminal states, the transition
  // out of "loading" only ADDS elements — it never replaces one auth-aware
  // element with another. SEO crawlers see exactly this minimal public nav
  // in the initial HTML, which is correct: Dashboard / Admin are auth-gated
  // and not useful for indexing.
  render() {
    const isUser = this.status === 'user' && this.user !== null;
    const isAnon = this.status === 'anon';
    const user = this.user;

    return html`
      <header
        class="sticky top-0 z-10 border-b border-neutral-200 bg-white/80 backdrop-blur"
      >
        <nav
          aria-label="primary"
          class="mx-auto flex max-w-3xl items-center gap-1 px-4 py-3"
        >
          <a href="/" class="${linkBase} text-neutral-900">Home</a>
          <a href="/about" class=${linkBase}>About</a>
          <a href="/subscribe" class=${linkBase}>Subscribe</a>

          ${isUser && user
            ? html`
                <a href="/dashboard" class=${linkBase}>Dashboard</a>
                ${user.roleName === 'admin'
                  ? html`<a href="/admin/users" class=${linkBase}>Admin</a>`
                  : nothing}
                <span
                  aria-label="signed-in user"
                  class="ml-auto truncate text-sm text-neutral-500"
                  title=${user.email}
                  >${user.email}</span
                >
                <button
                  type="button"
                  @click=${this.logout}
                  class="btn-ghost"
                >
                  Logout
                </button>
              `
            : nothing}
          ${isAnon
            ? html`<a href="/login" class="${linkBase} ml-auto">Login</a>`
            : nothing}
        </nav>
      </header>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'hy-auth-nav': HyAuthNav;
  }
}
