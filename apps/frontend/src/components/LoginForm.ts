import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  browserSupportsWebAuthn,
  startAuthentication,
} from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { api, ApiError } from '../lib/api';
import { bumpAuthSync, clearAuthCache } from '../lib/authState';
import {
  confirmLoginRedirect,
  getNextPath,
  loginRedirectFromCache,
} from '../lib/redirectIfAuthed';
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
  // /admin/users.
  @state() private ready = false;
  @state() private step: Step = 'email';
  @state() private email = '';
  @state() private code = '';
  @state() private session = '';
  @state() private busy = false;
  @state() private passkeyBusy = false;
  @state() private error: string | null = null;
  @state() private info: string | null = null;
  // Hide the passkey button on browsers without WebAuthn (very old
  // Safari/Firefox builds) — better than letting the user click a dead
  // button. Defaults to false; flipped true in firstUpdated.
  @state() private passkeySupported = false;
  // Honeypot input. Real users never fill this (aria-hidden + offscreen
  // + tabindex -1). Bots that scrape every input land their value here,
  // and the server then routes them down the fake-session path. Bound
  // here so we can include the value in the request.
  @state() private honeypot = '';

  private loadingDelay = new DeferredLoadingController(this);

  async firstUpdated() {
    // 1) Synchronous cache check. If we already know the visitor is signed
    //    in (state=user, cached session expiry still in the future), redirect
    //    immediately — don't bother rendering the form.
    const cached = loginRedirectFromCache('/admin/users');
    if ('redirect' in cached) {
      window.location.replace(cached.redirect);
      return;
    }

    // 2) Render the form NOW. Optimistic-anon: assume the visitor is the
    //    common case (anonymous) and paint the form on first frame rather
    //    than waiting on /me. Lambda cold-start can make /me take 15+ s;
    //    there's no reason to make every anon visitor wait that long for
    //    a form that needs no data at all.
    this.ready = true;
    this.passkeySupported = browserSupportsWebAuthn();

    // 3) Background confirmation. If /me eventually says the visitor IS
    //    actually signed in (rare: stale tab session, just-cleared cache),
    //    redirect them away. They saw the form briefly — acceptable
    //    trade-off for the common-case speedup.
    const confirmed = await confirmLoginRedirect('/admin/users');
    if (confirmed) window.location.replace(confirmed.redirect);
  }

  // After OTP- or passkey-success, both paths share this exact tail:
  // invalidate the local auth cache, signal other tabs, and land the user
  // at the right home route. Factored out so the two flows can't drift.
  private finishSignIn(): void {
    clearAuthCache();
    bumpAuthSync();
    window.location.href = getNextPath('/admin/users');
  }

  private async signInWithPasskey() {
    this.error = null;
    this.info = null;
    this.passkeyBusy = true;
    try {
      // 1) Ask the server for options + a challengeId. No email body — we
      //    rely on discoverable credentials so the OS picks the right
      //    passkey on its own.
      const { challengeId, options } = await api<{
        challengeId: string;
        options: PublicKeyCredentialRequestOptionsJSON;
      }>('/api/webauthn/authenticate/options', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      // 2) Let the OS produce an assertion. NotAllowedError = user
      //    dismissed (or no eligible passkey) — fall through silently so
      //    they can use email/OTP.
      let response;
      try {
        response = await startAuthentication({ optionsJSON: options });
      } catch (err) {
        if (err instanceof Error && err.name === 'NotAllowedError') {
          return; // silent fallback to OTP form below
        }
        throw err;
      }

      // 3) Verify on the server and pick up the session cookie.
      await api('/api/webauthn/authenticate/verify', {
        method: 'POST',
        body: JSON.stringify({ challengeId, response }),
      });

      this.finishSignIn();
    } catch (err) {
      this.error = friendlyLoginError(
        err,
        "We couldn't sign you in with that passkey. Try again, or use the email form below.",
      );
    } finally {
      this.passkeyBusy = false;
    }
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
      // Auth state just changed server-side. Drop any stale cache (might
      // have been an 'anon' snapshot from before this login) and signal
      // other tabs to re-fetch — the next page lands with the right nav
      // on first paint, no stale "Login" link visible.
      //
      // We don't write a fresh 'user' verdict here even though we just
      // authenticated: that would require the /me-shape response from
      // verify-otp (which currently returns nothing). Cheaper to clear
      // and let AuthNav's mount on the next page populate it from /me.
      this.finishSignIn();
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
              ${this.passkeySupported
                ? html`
                    <div class="space-y-3">
                      <button
                        type="button"
                        ?disabled=${this.passkeyBusy || this.busy}
                        @click=${this.signInWithPasskey}
                        class="btn-primary flex w-full items-center justify-center gap-2"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          class="h-5 w-5"
                          aria-hidden="true"
                        >
                          <path d="M12 11c0 7-5 9-5 9" />
                          <path d="M16 22c0 0 5-3 5-10A9 9 0 0 0 7 4.6" />
                          <path d="M3.1 9a9 9 0 0 1 4-4.4" />
                          <path d="M4 22c1.4-2 2-4.5 2-7v-1a6 6 0 0 1 12 0v.6" />
                          <path d="M14 13c.5 5-2 8-3.5 9.5" />
                          <path d="M9 6.8a6 6 0 0 1 9 5.2" />
                        </svg>
                        <span>
                          ${this.passkeyBusy
                            ? 'Waking your passkey…'
                            : 'Sign in with passkey'}
                        </span>
                      </button>
                      <div class="flex items-center gap-3 text-xs text-neutral-500">
                        <span class="h-px flex-1 bg-neutral-200"></span>
                        <span>or sign in with email</span>
                        <span class="h-px flex-1 bg-neutral-200"></span>
                      </div>
                    </div>
                  `
                : nothing}
              <form
                @submit=${this.requestOtp}
                class="space-y-4 ${this.passkeySupported ? 'mt-4' : ''}"
              >
                ${this.renderHoneypot()}
                <div>
                  <label for="email" class="label">Email</label>
                  <input
                    id="email"
                    type="email"
                    autocomplete="email webauthn"
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
                  ?disabled=${this.busy || this.passkeyBusy}
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
