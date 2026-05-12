import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { api, friendlyError } from '../lib/api';
import {
  DeferredLoadingController,
  skelLineSmall,
  skelTable,
} from '../lib/skeleton';

interface Subscription {
  id: string;
  email: string;
  createdAt: string;
}

type Status = 'loading' | 'forbidden' | 'ready';

@customElement('hy-admin-subscriptions')
export class HyAdminSubscriptions extends LitElement {
  createRenderRoot() {
    return this;
  }

  @state() private status: Status = 'loading';
  @state() private subs: Subscription[] = [];
  @state() private error: string | null = null;

  private loadingDelay = new DeferredLoadingController(this);

  async firstUpdated() {
    try {
      const list = await api<Subscription[]>('/api/admin/subscriptions');
      this.subs = list;
      this.status = 'ready';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('401')) {
        window.location.replace('/login?next=/admin/subscriptions');
        return;
      }
      if (msg.startsWith('403')) {
        this.status = 'forbidden';
        return;
      }
      this.error = friendlyError(err, "Couldn't load subscriptions.");
    }
  }

  private renderSkeleton(): TemplateResult {
    return html`
      <div class="space-y-6 animate-pulse">
        ${skelLineSmall('w-3/4')} ${skelTable(4, 2)}
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
          Emails captured by the public <a href="/subscribe">/subscribe</a>
          form. Most recent first, capped at 200.
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
        ${this.subs.length === 0
          ? html`
              <div
                class="card p-6 text-center text-sm text-neutral-500"
              >
                No subscriptions yet. Visit
                <a href="/subscribe">/subscribe</a> to add one.
              </div>
            `
          : html`
              <div class="card overflow-hidden">
                <table class="w-full text-sm">
                  <thead
                    class="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500"
                  >
                    <tr>
                      <th class="px-4 py-2 font-medium">Email</th>
                      <th class="px-4 py-2 font-medium text-right">
                        Subscribed
                      </th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-neutral-200">
                    ${this.subs.map(
                      (s) => html`
                        <tr class="hover:bg-neutral-50">
                          <td
                            class="px-4 py-2 font-medium text-neutral-900"
                          >
                            ${s.email}
                          </td>
                          <td
                            class="px-4 py-2 text-right text-neutral-500"
                          >
                            ${new Date(s.createdAt).toLocaleString()}
                          </td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
                <div
                  class="border-t border-neutral-200 bg-neutral-50 px-4 py-2 text-xs text-neutral-500"
                >
                  ${this.subs.length} subscription${this.subs.length === 1
                    ? ''
                    : 's'}
                </div>
              </div>
            `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'hy-admin-subscriptions': HyAdminSubscriptions;
  }
}
