// Post-login invite. When the signed-in user has no registered passkeys
// AND the browser supports WebAuthn AND they haven't dismissed the
// banner, render a one-click "Activate passkey" call-to-action above the
// admin content. Triggers the same registration flow as the Settings
// card via lib/passkey.ts.
//
// Lifecycle:
//   • mount  → GET /api/webauthn/credentials (returns 401 if the call
//             beats /me's cache, in which case we just stay hidden — the
//             AdminBase gate has already redirected anon visitors)
//   • empty  → render banner
//   • click  → registerPasskey() → hide on success
//   • dismiss → set localStorage flag → hide; banner won't reappear
//
// The dismissal is per-browser (localStorage). A user who deliberately
// said "not now" shouldn't have to dismiss the banner on every page load.
import { LitElement, html, nothing, svg } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { api, ApiError, friendlyError } from '../lib/api';
import {
  PASSKEY_ICON_PATHS,
  defaultDeviceLabel,
  registerPasskey,
} from '../lib/passkey';

const DISMISS_KEY = 'hereya_passkey_invite_dismissed_v1';

function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function markDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // localStorage disabled — fall through; banner just reappears next load.
  }
}

@customElement('hy-passkey-banner')
export class HyPasskeyBanner extends LitElement {
  createRenderRoot() {
    return this;
  }

  @state() private show = false;
  @state() private busy = false;
  @state() private error: string | null = null;

  connectedCallback() {
    super.connectedCallback();
    void this.maybeShow();
  }

  private async maybeShow() {
    if (!browserSupportsWebAuthn()) return;
    if (isDismissed()) return;
    try {
      const creds = await api<unknown[]>('/api/webauthn/credentials');
      if (Array.isArray(creds) && creds.length === 0) {
        this.show = true;
      }
    } catch (err) {
      // Anon (401) or transient error → stay hidden silently. The banner
      // is an enhancement, not a requirement.
      if (!(err instanceof ApiError)) {
        // eslint-disable-next-line no-console
        console.warn('[passkey-banner] credentials lookup failed:', err);
      }
    }
  }

  private dismiss = () => {
    markDismissed();
    this.show = false;
  };

  private async activate() {
    this.error = null;
    this.busy = true;
    try {
      const result = await registerPasskey(defaultDeviceLabel());
      if (result.status === 'cancelled') return; // user closed OS prompt
      this.show = false;
    } catch (err) {
      this.error = friendlyError(
        err,
        "Couldn't register a passkey on this device.",
      );
    } finally {
      this.busy = false;
    }
  }

  render() {
    if (!this.show) return nothing;
    return html`
      <div
        class="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-indigo-100 bg-indigo-50 p-4"
        role="region"
        aria-label="Set up a passkey"
      >
        <div class="flex items-start gap-3">
          <span
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white"
            aria-hidden="true"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="h-6 w-6"
            >
              ${PASSKEY_ICON_PATHS.map(
                // Must use `svg` not `html` here — nested template fragments
                // default to the HTML namespace, which would create unrendered
                // HTMLUnknownElements instead of SVGPathElements.
                (d) => svg`<path d=${d}></path>`,
              )}
            </svg>
          </span>
          <div>
            <p class="text-sm font-semibold text-indigo-900">
              Skip the email code next time
            </p>
            <p class="text-xs text-indigo-800/80">
              Register this device as a passkey and sign in with one
              click — no waiting for a code in your inbox.
            </p>
            ${this.error
              ? html`<p class="mt-1 text-xs text-rose-600">${this.error}</p>`
              : nothing}
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            ?disabled=${this.busy}
            @click=${this.activate}
            class="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            ${this.busy ? 'Activating…' : 'Set up passkey'}
          </button>
          <button
            type="button"
            ?disabled=${this.busy}
            @click=${this.dismiss}
            class="rounded-md px-2 py-1.5 text-sm text-indigo-700 hover:bg-indigo-100"
          >
            Not now
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'hy-passkey-banner': HyPasskeyBanner;
  }
}
