import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { api, friendlyError } from '../lib/api';
import {
  DeferredLoadingController,
  skelLineSmall,
  skelTable,
} from '../lib/skeleton';

// Schema-less: at minimum email + createdAt; any extra fields a project's
// form captured (name, company, referrer, etc.) ride along on the same
// row. The table renders email + createdAt + name (if present); extra
// fields beyond that surface in a tooltip on the row to keep the UI
// minimal — projects that want a full custom column set can override.
interface Registration {
  email: string;
  createdAt: string;
  name?: string;
  [extra: string]: unknown;
}

// Auth gate lives in AdminBase.astro's inline <head> script — see AdminUsers.
type Status = 'loading' | 'forbidden' | 'ready';

@customElement('hy-admin-registrations')
export class HyAdminRegistrations extends LitElement {
  createRenderRoot() {
    return this;
  }

  @state() private status: Status = 'loading';
  @state() private rows: Registration[] = [];
  @state() private busyEmail: string | null = null;
  @state() private error: string | null = null;

  private loadingDelay = new DeferredLoadingController(this);

  async firstUpdated() {
    await this.reload();
  }

  private async reload() {
    try {
      const list = await api<Registration[]>('/api/admin/registrations');
      this.rows = list;
      this.status = 'ready';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('401')) {
        window.location.replace('/login?next=/admin/registrations');
        return;
      }
      if (msg.startsWith('403')) {
        this.status = 'forbidden';
        return;
      }
      this.error = friendlyError(err, "Couldn't load registrations.");
    }
  }

  private async deleteRow(r: Registration) {
    if (!confirm(`Delete registration for ${r.email}? This can't be undone.`)) return;
    this.error = null;
    this.busyEmail = r.email;
    try {
      await api(`/api/admin/registrations/${encodeURIComponent(r.email)}`, {
        method: 'DELETE',
      });
      this.rows = this.rows.filter((x) => x.email !== r.email);
    } catch (err) {
      this.error = friendlyError(err, `Couldn't delete ${r.email}.`);
    } finally {
      this.busyEmail = null;
    }
  }

  private renderSkeleton(): TemplateResult {
    return html`
      <div class="space-y-6 animate-pulse">
        ${skelLineSmall('w-3/4')} ${skelTable(4, 3)}
      </div>
    `;
  }

  render() {
    if (this.status === 'loading' || this.loadingDelay.holdSkeleton) {
      return this.loadingDelay.deferred(this.renderSkeleton());
    }
    if (this.status === 'forbidden') {
      return html`
        <div class="card p-6 text-sm text-neutral-700">
          <p class="mb-2 font-medium text-neutral-900">Not authorized</p>
          <p>You don't have permission to view this page.</p>
        </div>
      `;
    }

    return html`
      <div class="space-y-6">
        <p class="text-sm text-neutral-600">
          Emails captured by the public <a href="/register">/register</a>
          form. Most recent first.
        </p>

        ${this.error
          ? html`
              <div
                class="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
              >
                ${this.error}
              </div>
            `
          : nothing}
        ${this.rows.length === 0
          ? html`
              <div class="card p-6 text-center text-sm text-neutral-500">
                No registrations yet. Visit
                <a href="/register">/register</a> to add one.
              </div>
            `
          : html`
              <div class="card overflow-hidden">
                <table class="w-full text-sm">
                  <thead
                    class="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500"
                  >
                    <tr>
                      <th class="px-4 py-2 font-medium">Name</th>
                      <th class="px-4 py-2 font-medium">Email</th>
                      <th class="px-4 py-2 font-medium">Registered</th>
                      <th class="px-4 py-2 font-medium text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-neutral-200">
                    ${this.rows.map(
                      (r) => html`
                        <tr class="hover:bg-neutral-50">
                          <td class="px-4 py-2 font-medium text-neutral-900">
                            ${r.name ?? html`<span class="text-neutral-400">—</span>`}
                          </td>
                          <td class="px-4 py-2 text-neutral-700">${r.email}</td>
                          <td class="px-4 py-2 text-neutral-500">
                            ${new Date(r.createdAt).toLocaleString()}
                          </td>
                          <td class="px-4 py-2 text-right">
                            <button
                              type="button"
                              @click=${() => this.deleteRow(r)}
                              ?disabled=${this.busyEmail === r.email}
                              class="btn-danger"
                            >
                              ${this.busyEmail === r.email ? 'Deleting…' : 'Delete'}
                            </button>
                          </td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
                <div
                  class="border-t border-neutral-200 bg-neutral-50 px-4 py-2 text-xs text-neutral-500"
                >
                  ${this.rows.length} registration${this.rows.length === 1 ? '' : 's'}
                </div>
              </div>
            `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'hy-admin-registrations': HyAdminRegistrations;
  }
}
