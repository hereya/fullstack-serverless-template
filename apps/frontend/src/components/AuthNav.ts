import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { api } from '../lib/api';
import {
  type Me,
  bumpAuthSync,
  clearAuthCache,
  onAuthSync,
  resolveAuth,
  snapshot,
} from '../lib/authState';

type Status = 'loading' | 'anon' | 'user';

const linkBase =
  'rounded px-2 py-1 text-sm font-medium transition-colors hover:bg-neutral-100';

@customElement('hy-auth-nav')
export class HyAuthNav extends LitElement {
  createRenderRoot() {
    return this;
  }

  // Initial state is read SYNCHRONOUSLY from the shared cache in the
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
  private unbindSync: (() => void) | null = null;

  constructor() {
    super();
    const snap = snapshot();
    if (snap.kind === 'user') {
      this.status = 'user';
      this.user = snap.user;
      this.hadCache = true;
    } else if (snap.kind === 'anon') {
      this.status = 'anon';
      this.hadCache = true;
    }
    // else: stay at 'loading'; firstUpdated will resolve via /me.
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
    // why this listener doesn't loop with our own bumpAuthSync() calls.
    this.unbindSync = onAuthSync(() => {
      clearAuthCache();
      void this.refresh();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.cancelled = true;
    if (this.unbindSync) {
      this.unbindSync();
      this.unbindSync = null;
    }
  }

  private async refresh() {
    const snap = await resolveAuth();
    if (this.cancelled) return;
    if (snap.kind === 'user') {
      this.user = snap.user;
      this.status = 'user';
    } else if (snap.kind === 'anon') {
      this.user = null;
      this.status = 'anon';
    } else {
      // 'unknown' — /me failed without a 401 (5xx / network). Visually
      // fall back to anon so the loading state doesn't linger; resolveAuth
      // intentionally did NOT write to cache, so the next mount retries.
      this.user = null;
      this.status = 'anon';
    }
  }

  private async logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // best-effort
    }
    clearAuthCache();
    bumpAuthSync(); // tell sibling tabs to drop their cache + re-fetch
    window.location.href = '/';
  }

  // Three nav states, chosen so the user never sees information change:
  //
  //   loading → only the public links (Home / About / Register). Auth-
  //             dependent elements are absent.
  //   anon    → public links + Login.
  //   user    → public links + [Admin] + email + Logout.
  //
  // Because "loading" is a subset of both terminal states, the transition
  // out of "loading" only ADDS elements — it never replaces one auth-aware
  // element with another. SEO crawlers see the minimal public nav in the
  // initial HTML; Admin is auth-gated and not useful for indexing.
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
          <a href="/register" class=${linkBase}>Register</a>

          ${isUser && user
            ? html`
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
