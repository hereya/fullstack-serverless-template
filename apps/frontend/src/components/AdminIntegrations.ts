import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { api, friendlyError } from '../lib/api';
import {
  DeferredLoadingController,
  skelLineSmall,
  skelTable,
} from '../lib/skeleton';

interface Connection {
  tokenId: string;
  clientId: string;
  clientName: string;
  scope: string;
  createdAt: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

// Auth gate lives in AdminBase.astro's inline <head> script — see AdminUsers.
type Status = 'loading' | 'forbidden' | 'ready';

@customElement('hy-admin-integrations')
export class HyAdminIntegrations extends LitElement {
  createRenderRoot() {
    return this;
  }

  @state() private status: Status = 'loading';
  @state() private connections: Connection[] = [];
  @state() private busyTokenId: string | null = null;
  @state() private error: string | null = null;

  private loadingDelay = new DeferredLoadingController(this);

  async firstUpdated() {
    await this.reload();
  }

  private async reload() {
    try {
      const list = await api<Connection[]>('/api/admin/integrations');
      this.connections = list;
      this.status = 'ready';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('401')) {
        window.location.replace('/login?next=/admin/integrations');
        return;
      }
      if (msg.startsWith('403')) {
        this.status = 'forbidden';
        return;
      }
      this.error = friendlyError(err, "Couldn't load integrations.");
    }
  }

  private async revoke(c: Connection) {
    this.error = null;
    this.busyTokenId = c.tokenId;
    try {
      await api(`/api/admin/integrations/${c.tokenId}`, { method: 'DELETE' });
      this.connections = this.connections.filter(
        (x) => x.tokenId !== c.tokenId,
      );
    } catch (err) {
      this.error = friendlyError(err, `Couldn't revoke ${c.clientName}.`);
    } finally {
      this.busyTokenId = null;
    }
  }

  private renderSkeleton(): TemplateResult {
    return html`
      <div class="space-y-6 animate-pulse">
        ${skelLineSmall('w-3/4')} ${skelTable(3, 4)}
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
            You don't have permission to manage MCP connections.
            <a href="/dashboard">Back to dashboard</a>
          </p>
        </div>
      `;
    }

    return html`
      <div class="space-y-6">
        <p class="text-sm text-neutral-600">
          MCP clients you have authorized to act on your behalf via
          <a href="/.well-known/oauth-protected-resource"><code>/mcp</code></a>.
          Revoking takes effect on the client's next request (within seconds).
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
        ${this.connections.length === 0
          ? html`
              <div class="card p-6 text-center text-sm text-neutral-500">
                You haven't authorized any MCP clients yet. From your client,
                connect to
                <code class="rounded bg-neutral-100 px-1">${window.location.origin}/mcp</code>
                — you'll be brought back here to consent.
              </div>
            `
          : html`
              <div class="card overflow-hidden">
                <table class="w-full text-sm">
                  <thead
                    class="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500"
                  >
                    <tr>
                      <th class="px-4 py-2 font-medium">Client</th>
                      <th class="px-4 py-2 font-medium">Authorized</th>
                      <th class="px-4 py-2 font-medium">Access expires</th>
                      <th class="px-4 py-2 font-medium text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-neutral-200">
                    ${this.connections.map(
                      (c) => html`
                        <tr class="hover:bg-neutral-50">
                          <td class="px-4 py-2">
                            <div class="font-medium text-neutral-900">
                              ${c.clientName}
                            </div>
                            <div class="text-xs text-neutral-400">
                              ${c.clientId}
                            </div>
                          </td>
                          <td class="px-4 py-2 text-neutral-500">
                            ${new Date(c.createdAt).toLocaleString()}
                          </td>
                          <td class="px-4 py-2 text-neutral-500">
                            ${new Date(c.accessExpiresAt).toLocaleString()}
                          </td>
                          <td class="px-4 py-2 text-right">
                            <button
                              type="button"
                              @click=${() => this.revoke(c)}
                              ?disabled=${this.busyTokenId === c.tokenId}
                              class="btn-danger"
                            >
                              ${this.busyTokenId === c.tokenId
                                ? 'Revoking…'
                                : 'Revoke'}
                            </button>
                          </td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </div>
            `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'hy-admin-integrations': HyAdminIntegrations;
  }
}
