import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Shared sub-nav at the top of /admin/* pages. Renders as plain anchors so
// it works fine even if any single admin page's island fails to hydrate.
// `current` controls the visual "active" state and is set declaratively
// from the parent .astro page.
//
// No auth gate here: the /admin/* Astro layout (AdminBase) injects an
// inline <head> script that redirects anon visitors BEFORE any body
// paint, so the tabs can render unconditionally — we only reach here as
// a cached-user visitor with a session that hasn't naturally expired.
type Tab = 'users' | 'registrations' | 'integrations';

const tabs: Array<{ key: Tab; href: string; label: string }> = [
  { key: 'users', href: '/admin/users', label: 'Users' },
  { key: 'registrations', href: '/admin/registrations', label: 'Registrations' },
  { key: 'integrations', href: '/admin/integrations', label: 'Integrations' },
];

@customElement('hy-admin-tabs')
export class HyAdminTabs extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: String }) current: Tab = 'users';

  render() {
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
