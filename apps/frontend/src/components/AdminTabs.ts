import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { resolveAuth, snapshot } from '../lib/authState';

// Shared sub-nav at the top of /admin/* pages. Renders as plain anchors so
// it works fine even if any single admin page's island fails to hydrate.
// `current` controls the visual "active" state and is set declaratively
// from the parent .astro page.
//
// Visibility gate: we render NOTHING until the shared auth state confirms
// the visitor is signed in. Without this gate the menu was visible during
// the Aurora cold-start window for anonymous visitors who had landed on
// /admin/* directly (e.g. via a bookmark) — the page's data island would
// take ~5s to 401 + redirect, and the menu sat there the whole time. With
// the gate, anon visitors never see the menu at all: a synchronous cache
// hit in the constructor either reveals it on first paint (cached 'user')
// or keeps it hidden; firstUpdated() then confirms via /me (DDB-only, no
// Aurora) within ms.
type Tab = 'users' | 'subscriptions' | 'integrations';

const tabs: Array<{ key: Tab; href: string; label: string }> = [
  { key: 'users', href: '/admin/users', label: 'Users' },
  { key: 'subscriptions', href: '/admin/subscriptions', label: 'Subscriptions' },
  { key: 'integrations', href: '/admin/integrations', label: 'Integrations' },
];

@customElement('hy-admin-tabs')
export class HyAdminTabs extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: String }) current: Tab = 'users';

  // 'hidden' until we positively know the visitor is signed in. 'visible'
  // once any signal (cached or freshly-fetched) says so. We don't bother
  // with a distinct 'forbidden' state because /admin/* pages are admin-only
  // — a signed-in non-admin sees the page's own forbidden card AND the
  // tabs, which is fine (the tabs just take them to other admin pages
  // they also can't access).
  @state() private visible: 'hidden' | 'visible' = 'hidden';

  constructor() {
    super();
    if (snapshot().kind === 'user') {
      this.visible = 'visible';
    }
  }

  async firstUpdated() {
    if (this.visible === 'visible') return;
    const snap = await resolveAuth();
    if (snap.kind === 'user') {
      this.visible = 'visible';
    }
    // 'anon' or 'unknown': stay hidden. The page-level admin island will
    // already be calling requireAdmin() which fires the /login redirect.
  }

  render() {
    if (this.visible === 'hidden') return nothing;
    return html`
      <nav
        aria-label="admin sections"
        class="flex gap-1 border-b border-neutral-200"
      >
        ${tabs.map((t) => {
          const active = t.key === this.current;
          return html`
            <a
              href=${t.href}
              class=${active
                ? 'border-b-2 border-blue-600 px-3 py-2 text-sm font-medium text-blue-700'
                : 'border-b-2 border-transparent px-3 py-2 text-sm font-medium text-neutral-500 hover:text-neutral-700'}
              aria-current=${active ? 'page' : 'false'}
            >
              ${t.label}
            </a>
          `;
        })}
      </nav>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'hy-admin-tabs': HyAdminTabs;
  }
}
