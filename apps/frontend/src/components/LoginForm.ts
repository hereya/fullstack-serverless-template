import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { api, ApiError } from '../lib/api';
import { getNextPath, resolveLoginRedirect } from '../lib/redirectIfAuthed';
import { DeferredLoadingController, skelFormCard } from '../lib/skeleton';

// Map a thrown error to a user-facing string. Never surface raw status
// codes ("401 Unauthorized") — those look like bugs from the user's
// perspective, especially on an auth screen where 401 is the EXPECTED
// failure mode for a wrong code.
function friendlyLoginError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return "That code didn't work. Try again, or use Resend code below.";
    }
    if (err.status === 429) {
      return 'Too many attempts — please wait a minute and try again.';
    }
    if (err.status === 400) {
      return 'Please check your email or code and try again.';
    }
    if (err.status >= 500) {
      return 'Something went wrong on our end. Please try again in a moment.';
    }
  }
  // Network failure (CORS, offline, DNS), or a non-fetch error.
  if (err instanceof TypeError) {
    return "We couldn't reach the server. Check your connection and try again.";
  }
  return fallback;
}

type Step = 'email' | 'otp';

interface RequestOtpResponse {
  session: string;
}

// Off-screen styling for the honeypot input. We don't use `display:none`
// because some accessibility tools (and certain bot scripts) treat that
// as "skip" — we WANT bots to see and fill it.
const HONEYPOT_STYLE =
  'position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden;';

@customElement('hy-login-form')
export class HyLoginForm extends LitElement {
  createRenderRoot() {
    return this;
  }

  // `ready` mirrors the previous React `useRedirectIfAuthed` semantics:
  // we render nothing until we know the visitor is anon, otherwise the
  // form would flash before window.location.replace() lands them on
  // /dashboard.
  @state() private ready = false;
  @state() private step: Step = 'email';
  @state() private email = '';
  @state() private code = '';
  @state() private session = '';
  @state() private busy = false;
  @state() private error: string | null = null;
  @state() private info: string | null = null;
  // Honeypot input. Real users never fill this (aria-hidden + offscreen
  // + tabindex -1). Bots that scrape every input land their value here,
  // and the server then routes them down the fake-session path. Bound
  // here so we can include the value in the request.
  @state() private honeypot = '';

  private loadingDelay = new DeferredLoadingController(this);

  async firstUpdated() {
    const r = await resolveLoginRedirect('/dashboard');
    if ('redirect' in r) {
      window.location.replace(r.redirect);
      return;
    }
    this.ready = true;
  }

  // Core "ask the server for a code" — used by both the initial submit
  // and the "Resend code" button on the OTP step. Returns true on
  // success so callers can show a transient confirmation.
  private async sendCode(): Promise<boolean> {
    this.error = null;
    this.info = null;
    this.busy = true;
    try {
      const data = await api<RequestOtpResponse>('/api/auth/request-otp', {
        method: 'POST',
        body: JSON.stringify({
          email: this.email,
          // Honeypot — bots fill it, humans don't. The server treats
          // any non-empty value as a likely bot and silently routes the
          // call down the fake-session path.
          website: this.honeypot,
        }),
      });
      this.session = data.session;
      return true;
    } catch (err) {
      this.error = friendlyLoginError(err, "We couldn't send a code. Please try again.");
      return false;
    } finally {
      this.busy = false;
    }
  }

  private async requestOtp(e: Event) {
    e.preventDefault();
    const ok = await this.sendCode();
    if (ok) this.step = 'otp';
  }

  private async resendCode() {
    const ok = await this.sendCode();
    if (ok) {
      this.info = `New code sent to ${this.email}.`;
      // Clear any stale code the user had typed.
      this.code = '';
    }
  }

  private backToEmail() {
    this.step = 'email';
    this.code = '';
    this.session = '';
    this.error = null;
    this.info = null;
  }

  private async verifyOtp(e: Event) {
    e.preventDefault();
    this.error = null;
    this.info = null;
    this.busy = true;
    try {
      await api('/api/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify({
          email: this.email,
          session: this.session,
          code: this.code,
        }),
      });
      // Auth state just changed server-side. Drop any stale AuthNav cache
      // (which may have been an 'anon' snapshot from before this login)
      // so the next page renders the right nav immediately. Without this,
      // the post-login dashboard would show "Login" in the nav until the
      // 5-min cache TTL expired.
      try {
        sessionStorage.removeItem('hereya_authnav_v1');
        // Cross-tab signal: any sibling tabs showing the anon nav will
        // catch this storage event and re-fetch /me. The `storage` event
        // doesn't fire in the writing tab, so we don't loop with our
        // own location.href navigation below.
        localStorage.setItem('hereya_auth_sync_v1', String(Date.now()));
      } catch {
        // storage may be unavailable (private mode); ignore — the
        // current tab still navigates fine; siblings recover on TTL.
      }
      window.location.href = getNextPath('/dashboard');
    } catch (err) {
      this.error = friendlyLoginError(err, 'Invalid code. Try again.');
    } finally {
      this.busy = false;
    }
  }

  private renderHoneypot() {
    return html`
      <div aria-hidden="true" style=${HONEYPOT_STYLE}>
        <label>
          Website (do not fill)
          <input
            type="text"
            name="website"
            tabindex="-1"
            autocomplete="off"
            .value=${this.honeypot}
            @input=${(e: Event) => {
              this.honeypot = (e.target as HTMLInputElement).value;
            }}
          />
        </label>
      </div>
    `;
  }

  render() {
    // Show a placeholder card while resolveLoginRedirect resolves so the
    // page has the same visual rhythm as the loaded form. Deferred so a
    // fast cache hit doesn't flash the skeleton; if the visitor is authed
    // we'll redirect before the placeholder ever appears.
    if (!this.ready || this.loadingDelay.holdSkeleton) {
      return this.loadingDelay.deferred(skelFormCard());
    }

    return html`
      <div class="card mx-auto max-w-sm p-6">
        ${this.step === 'email'
          ? html`
              <form @submit=${this.requestOtp} class="space-y-4">
                ${this.renderHoneypot()}
                <div>
                  <label for="email" class="label">Email</label>
                  <input
                    id="email"
                    type="email"
                    autocomplete="email"
                    required
                    .value=${this.email}
                    @input=${(e: Event) => {
                      this.email = (e.target as HTMLInputElement).value;
                    }}
                    placeholder="you@example.com"
                    class="input"
                  />
                </div>
                <button
                  type="submit"
                  ?disabled=${this.busy}
                  class="btn-primary w-full"
                >
                  ${this.busy ? 'Sending…' : 'Send code'}
                </button>
                ${this.error
                  ? html`<p class="text-sm text-red-600">${this.error}</p>`
                  : nothing}
              </form>
            `
          : html`
              <form @submit=${this.verifyOtp} class="space-y-4">
                <p class="text-sm text-neutral-600">
                  We sent a code to
                  <strong class="text-neutral-900">${this.email}</strong>.
                </p>
                <div>
                  <label for="code" class="label">6-digit code</label>
                  <input
                    id="code"
                    inputmode="numeric"
                    pattern="\\d{6}"
                    maxlength="6"
                    required
                    autocomplete="one-time-code"
                    .value=${this.code}
                    @input=${(e: Event) => {
                      this.code = (e.target as HTMLInputElement).value;
                    }}
                    placeholder="123456"
                    class="input tracking-[0.5em] text-center font-mono text-lg"
                  />
                </div>
                <button
                  type="submit"
                  ?disabled=${this.busy}
                  class="btn-primary w-full"
                >
                  ${this.busy ? 'Verifying…' : 'Verify'}
                </button>
                ${this.info
                  ? html`<p class="text-sm text-emerald-700">${this.info}</p>`
                  : nothing}
                ${this.error
                  ? html`<p class="text-sm text-red-600">${this.error}</p>`
                  : nothing}
                <div class="flex items-center justify-between pt-1 text-sm">
                  <button
                    type="button"
                    @click=${this.backToEmail}
                    ?disabled=${this.busy}
                    class="text-blue-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    ← Use a different email
                  </button>
                  <button
                    type="button"
                    @click=${this.resendCode}
                    ?disabled=${this.busy}
                    class="text-blue-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Resend code
                  </button>
                </div>
              </form>
            `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'hy-login-form': HyLoginForm;
  }
}
