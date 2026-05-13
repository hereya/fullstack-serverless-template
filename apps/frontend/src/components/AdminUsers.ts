import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { api, friendlyError } from '../lib/api';
import { requireAdmin } from '../lib/authState';
import {
  DeferredLoadingController,
  skelButton,
  skelInput,
  skelLine,
  skelLineSmall,
  skelTable,
} from '../lib/skeleton';

interface AdminUser {
  id: string;
  email: string;
  roleName: string;
  suspended: boolean;
  hasSignedIn: boolean;
  createdAt: string;
}

// 'auth-pending' is the initial state: we haven't even confirmed the
// visitor is signed in yet, so the page renders nothing (matches the
// AdminTabs gate — no admin chrome visible to anon visitors during the
// Aurora cold-start window). Once requireAdmin resolves we either bounce
// to /login (no state change needed — navigation takes over) or move to
// 'loading' and kick off the actual data fetch.
type Status = 'auth-pending' | 'loading' | 'forbidden' | 'ready';

@customElement('hy-admin-users')
export class HyAdminUsers extends LitElement {
  createRenderRoot() {
    return this;
  }

  @state() private status: Status = 'auth-pending';
  @state() private users: AdminUser[] = [];
  @state() private newEmail = '';
  @state() private busy = false;
  @state() private error: string | null = null;

  private loadingDelay = new DeferredLoadingController(this);

  async firstUpdated() {
    const snap = await requireAdmin('/admin/users');
    if (snap.kind !== 'user') return; // anon → navigation in progress
    this.status = 'loading';
    void this.reload();
  }

  private async reload() {
    try {
      const list = await api<AdminUser[]>('/api/admin/users');
      this.users = list;
      this.status = 'ready';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('401')) {
        window.location.replace('/login?next=/admin/users');
        return;
      }
      if (msg.startsWith('403')) {
        this.status = 'forbidden';
        return;
      }
      this.error = msg;
    }
  }

  private async addUser(e: Event) {
    e.preventDefault();
    this.error = null;
    this.busy = true;
    try {
      const created = await api<AdminUser>('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email: this.newEmail }),
      });
      this.users = [...this.users, created];
      this.newEmail = '';
    } catch (err) {
      this.error = friendlyError(err, "Couldn't add that user.");
    } finally {
      this.busy = false;
    }
  }

  private async toggleSuspended(u: AdminUser) {
    const next = !u.suspended;
    // Optimistic update
    this.users = this.users.map((x) =>
      x.id === u.id ? { ...x, suspended: next } : x,
    );
    try {
      const updated = await api<AdminUser>(`/api/admin/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ suspended: next }),
      });
      this.users = this.users.map((x) => (x.id === u.id ? updated : x));
    } catch (err) {
      // Revert
      this.users = this.users.map((x) =>
        x.id === u.id ? { ...x, suspended: !next } : x,
      );
      this.error = friendlyError(err, `Couldn't update ${u.email}.`);
    }
  }

  private renderRow(u: AdminUser): TemplateResult {
    return html`
      <tr class="hover:bg-neutral-50">
        <td class="px-4 py-2 font-medium text-neutral-900">${u.email}</td>
        <td class="px-4 py-2">
          <span class=${u.roleName === 'admin' ? 'badge-admin' : 'badge-neutral'}>
            ${u.roleName}
          </span>
        </td>
        <td class="px-4 py-2">
          ${u.suspended
            ? html`<span class="badge-warn">Suspended</span>`
            : html`<span class="badge-active">Active</span>`}
        </td>
        <td class="px-4 py-2">
          ${u.hasSignedIn
            ? html`<span class="badge-active">Yes</span>`
            : html`<span class="badge-neutral">No</span>`}
        </td>
        <td class="px-4 py-2 text-neutral-500">
          ${new Date(u.createdAt).toLocaleDateString()}
        </td>
        <td class="px-4 py-2 text-right">
          <button
            type="button"
            @click=${() => this.toggleSuspended(u)}
            class=${u.suspended ? 'btn-secondary' : 'btn-danger'}
          >
            ${u.suspended ? 'Unsuspend' : 'Suspend'}
          </button>
        </td>
      </tr>
    `;
  }

  private renderSkeleton(): TemplateResult {
    return html`
      <div class="space-y-6 animate-pulse">
        ${skelLineSmall('w-3/4')}

        <div class="card flex items-end gap-3 p-4">
          <div class="flex-1 space-y-2">
            ${skelLine('w-24')} ${skelInput()}
          </div>
          ${skelButton('w-20')}
        </div>

        ${skelTable(4, 6)}
      </div>
    `;
  }

  render() {
    if (this.status === 'auth-pending') {
      // Auth gate hasn't resolved yet — render NOTHING so anon visitors
      // (or anyone waiting on the /me probe) don't see an admin skeleton.
      // The probe is DDB-only so this state is short-lived (ms, not s).
      return nothing;
    }
    if (this.status === 'loading' || this.loadingDelay.holdSkeleton) {
      return this.loadingDelay.deferred(this.renderSkeleton());
    }
    if (this.status === 'forbidden') {
      return html`
        <div class="card p-6 text-sm text-neutral-700">
          <p class="mb-2 font-medium text-neutral-900">Not authorized</p>
          <p>
            You don't have permission to view this page.
            <a href="/dashboard">Back to dashboard</a>
          </p>
        </div>
      `;
    }

    return html`
      <div class="space-y-6">
        <p class="text-sm text-neutral-600">
          Only allow-listed emails can sign in. Add a user below; they can
          then request an OTP at <a href="/login">/login</a>.
        </p>

        <form
          @submit=${this.addUser}
          class="card flex items-end gap-3 p-4"
        >
          <div class="flex-1">
            <label for="new-email" class="label">Add a user</label>
            <input
              id="new-email"
              type="email"
              placeholder="email@example.com"
              required
              .value=${this.newEmail}
              @input=${(e: Event) => {
                this.newEmail = (e.target as HTMLInputElement).value;
              }}
              class="input"
            />
          </div>
          <button type="submit" ?disabled=${this.busy} class="btn-primary">
            ${this.busy ? 'Adding…' : 'Add'}
          </button>
        </form>

        ${this.error
          ? html`
              <div
                class="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
              >
                ${this.error}
              </div>
            `
          : nothing}

        <div class="card overflow-hidden">
          <table class="w-full text-sm">
            <thead
              class="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500"
            >
              <tr>
                <th class="px-4 py-2 font-medium">Email</th>
                <th class="px-4 py-2 font-medium">Role</th>
                <th class="px-4 py-2 font-medium">Status</th>
                <th class="px-4 py-2 font-medium">Signed in?</th>
                <th class="px-4 py-2 font-medium">Created</th>
                <th class="px-4 py-2 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-neutral-200">
              ${this.users.map((u) => this.renderRow(u))}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'hy-admin-users': HyAdminUsers;
  }
}
