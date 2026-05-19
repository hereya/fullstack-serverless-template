import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { api, friendlyError } from '../lib/api';
import { defaultDeviceLabel, registerPasskey } from '../lib/passkey';

interface CredentialRow {
  credentialId: string;
  deviceLabel: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

@customElement('hy-passkeys')
export class HyPasskeys extends LitElement {
  createRenderRoot() {
    return this;
  }

  @state() private loading = true;
  @state() private supported = false;
  @state() private credentials: CredentialRow[] = [];
  @state() private listError: string | null = null;

  @state() private deviceLabel = defaultDeviceLabel();
  @state() private registering = false;
  @state() private registerError: string | null = null;
  @state() private registerSaved = false;

  connectedCallback() {
    super.connectedCallback();
    this.supported = browserSupportsWebAuthn();
    void this.load();
  }

  private async load() {
    this.listError = null;
    try {
      this.credentials = await api<CredentialRow[]>('/api/webauthn/credentials');
    } catch (err) {
      this.listError = friendlyError(err, "Couldn't load passkeys.");
    } finally {
      this.loading = false;
    }
  }

  private async registerDevice(e: Event) {
    e.preventDefault();
    this.registerError = null;
    this.registerSaved = false;
    this.registering = true;
    try {
      const result = await registerPasskey(
        this.deviceLabel.trim() || defaultDeviceLabel(),
      );
      if (result.status === 'cancelled') return;
      this.registerSaved = true;
      setTimeout(() => (this.registerSaved = false), 1500);
      await this.load();
    } catch (err) {
      this.registerError = friendlyError(
        err,
        "Couldn't register that passkey.",
      );
    } finally {
      this.registering = false;
    }
  }

  private async revoke(cred: CredentialRow) {
    if (!confirm(`Remove passkey "${cred.deviceLabel}"?`)) return;
    try {
      await api(`/api/webauthn/credentials/${encodeURIComponent(cred.credentialId)}`, {
        method: 'DELETE',
      });
      await this.load();
    } catch {
      // best-effort — list refresh will reveal the actual state
      await this.load();
    }
  }

  render() {
    return html`
      <div class="space-y-3 rounded-md border border-neutral-200 bg-white p-4">
        <div>
          <h2 class="text-lg font-semibold">Passkeys</h2>
          <p class="text-xs text-neutral-500">
            Register this device for one-click sign-in next time — no
            email code needed.
          </p>
        </div>

        ${!this.supported
          ? html`
              <p class="text-sm text-rose-600">
                This browser doesn't support passkeys. Use an up-to-date
                Safari, Chrome, Firefox, or Edge.
              </p>
            `
          : this.loading
            ? html`<p class="text-sm text-neutral-500">Loading…</p>`
            : this.listError
              ? html`<p class="text-sm text-rose-600">${this.listError}</p>`
              : this.credentials.length === 0
                ? html`<p class="text-sm text-neutral-500">No passkeys registered.</p>`
                : html`<ul class="divide-y divide-neutral-200">
                    ${this.credentials.map(
                      (cred) => html`
                        <li class="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                          <div>
                            <div class="font-medium">${cred.deviceLabel}</div>
                            <div class="text-xs text-neutral-500">
                              Added ${formatDate(cred.createdAt)}
                              ${cred.lastUsedAt
                                ? html` · Last used
                                    ${formatDate(cred.lastUsedAt)}`
                                : nothing}
                            </div>
                          </div>
                          <button
                            type="button"
                            class="rounded px-2 py-1 text-xs text-rose-600 hover:bg-rose-50"
                            @click=${() => this.revoke(cred)}
                          >
                            Remove
                          </button>
                        </li>
                      `,
                    )}
                  </ul>`}
        ${this.supported
          ? html`
              <form
                @submit=${this.registerDevice}
                class="flex flex-wrap items-end gap-2 border-t border-neutral-200 pt-3"
              >
                <label class="block text-sm">
                  <span class="text-neutral-700">Device name</span>
                  <input
                    type="text"
                    required
                    class="mt-1 w-56 rounded-md border border-neutral-300 px-2 py-1"
                    .value=${this.deviceLabel}
                    @input=${(e: Event) =>
                      (this.deviceLabel = (e.target as HTMLInputElement).value)}
                    placeholder="Mac, iPhone, …"
                  />
                </label>
                <button
                  type="submit"
                  ?disabled=${this.registering}
                  class="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  ${this.registering ? 'Registering…' : '+ Register this device'}
                </button>
                ${this.registerSaved
                  ? html`<span class="text-xs text-emerald-600">Saved</span>`
                  : nothing}
                ${this.registerError
                  ? html`<span class="text-xs text-rose-600">${this.registerError}</span>`
                  : nothing}
              </form>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'hy-passkeys': HyPasskeys;
  }
}
