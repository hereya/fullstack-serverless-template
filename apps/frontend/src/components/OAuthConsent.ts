import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { api, friendlyError } from '../lib/api';
import { DeferredLoadingController, skelFormCard } from '../lib/skeleton';

// Consent page for the OAuth flow that backs the MCP integration.
//
// Lifecycle:
//   1. The MCP client opens GET /oauth/authorize?... in the browser.
//   2. Backend redirects here (to /connect?...) once it verifies the
//      visitor has a session AND the mcp:connect permission. So by
//      the time this island mounts, the user is already known to be
//      eligible. We re-show the consent text and let them approve.
//   3. On approve → POST /oauth/authorize/confirm → backend returns
//      { redirectTo } and we navigate.
//   4. On cancel → return to <redirect_uri>?error=access_denied.

interface AuthorizeParams {
  response_type: 'code';
  client_id: string;
  redirect_uri: string;
  scope: string;
  state?: string;
  code_challenge: string;
  code_challenge_method: 'S256';
}

interface ConfirmResponse {
  redirectTo: string;
}

// Tools the MCP server exposes. Hardcoded list mirrors what
// apps/backend/src/mcp/server.ts registers — keep in sync. If the
// list grows, render it dynamically by hitting an unauthenticated
// /api/mcp/tools-summary endpoint instead.
const TOOL_SUMMARY = [
  'List, add, and suspend users',
  'List newsletter subscriptions',
  'Read and update role permissions',
  'View aggregate app stats',
];

@customElement('hy-oauth-consent')
export class HyOAuthConsent extends LitElement {
  createRenderRoot() {
    return this;
  }

  @state() private params: AuthorizeParams | null = null;
  @state() private busy = false;
  @state() private error: string | null = null;

  private loadingDelay = new DeferredLoadingController(this);

  firstUpdated() {
    // Parse the OAuth query params off the URL. If the required ones
    // are missing, show an error — this page shouldn't have been
    // reached without them (backend redirect carries them).
    const q = new URLSearchParams(window.location.search);
    const required = [
      'response_type',
      'client_id',
      'redirect_uri',
      'code_challenge',
      'code_challenge_method',
    ] as const;
    for (const k of required) {
      if (!q.get(k)) {
        this.error = 'Missing OAuth parameters — open this page only via your MCP client.';
        return;
      }
    }
    this.params = {
      response_type: 'code',
      client_id: q.get('client_id')!,
      redirect_uri: q.get('redirect_uri')!,
      scope: q.get('scope') ?? 'mcp',
      state: q.get('state') ?? undefined,
      code_challenge: q.get('code_challenge')!,
      code_challenge_method: 'S256',
    };
  }

  private async approve() {
    if (!this.params) return;
    this.error = null;
    this.busy = true;
    try {
      const r = await api<ConfirmResponse>('/oauth/authorize/confirm', {
        method: 'POST',
        body: JSON.stringify(this.params),
      });
      window.location.href = r.redirectTo;
    } catch (err) {
      this.error = friendlyError(err, "Couldn't complete the authorization.");
      this.busy = false;
    }
  }

  private cancel() {
    if (!this.params) {
      window.location.href = '/';
      return;
    }
    const u = new URL(this.params.redirect_uri);
    u.searchParams.set('error', 'access_denied');
    if (this.params.state) u.searchParams.set('state', this.params.state);
    window.location.href = u.toString();
  }

  render() {
    if (!this.params && !this.error) {
      // Brief window between mount and firstUpdated parsing the URL.
      return this.loadingDelay.deferred(skelFormCard());
    }

    if (this.error && !this.params) {
      return html`
        <div class="card mx-auto max-w-md p-6 text-center">
          <p class="text-sm text-red-600">${this.error}</p>
          <a href="/" class="btn-secondary mt-4 inline-block">Go home</a>
        </div>
      `;
    }

    const p = this.params!;
    // Best-effort: show the bare hostname of redirect_uri so the user
    // can recognize their MCP client. Loopback URLs show "127.0.0.1".
    let host: string;
    try {
      host = new URL(p.redirect_uri).host;
    } catch {
      host = p.redirect_uri;
    }

    return html`
      <div class="card mx-auto max-w-md p-6 space-y-4">
        <h1>Connect MCP client</h1>
        <p class="text-sm text-neutral-600">
          A client at
          <code class="rounded bg-neutral-100 px-1">${host}</code>
          wants to act on your behalf via MCP. If you approve, it will be
          able to:
        </p>
        <ul class="list-disc space-y-1 pl-6 text-sm text-neutral-700">
          ${TOOL_SUMMARY.map((t) => html`<li>${t}</li>`)}
        </ul>
        <p class="text-xs text-neutral-500">
          Client ID: <code>${p.client_id}</code>. The access token is
          valid for 24h; you can revoke it any time from
          <a href="/admin/integrations">/admin/integrations</a>.
        </p>
        ${this.error
          ? html`<p class="text-sm text-red-600">${this.error}</p>`
          : nothing}
        <div class="flex justify-end gap-2 pt-2">
          <button
            type="button"
            @click=${this.cancel}
            ?disabled=${this.busy}
            class="btn-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            @click=${this.approve}
            ?disabled=${this.busy}
            class="btn-primary"
          >
            ${this.busy ? 'Approving…' : 'Approve'}
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'hy-oauth-consent': HyOAuthConsent;
  }
}
