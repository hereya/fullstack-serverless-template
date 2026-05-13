import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { api, friendlyError } from '../lib/api';

// Public registration form. No auth — anonymous visitors POST email +
// optional name (or any extra fields a project's variant captures —
// see docs/patterns/richer-registration.md for adding company / referrer /
// custom checkbox fields). Single POST to /api/registration; on success
// the form swaps out for a thank-you panel.
//
// Stored in DDB via hereya/aws-ddb-app-state's RegistrationsTable —
// schema-less, so the projects's own extra fields ride along without
// schema changes here.
@customElement('hy-registration')
export class HyRegistration extends LitElement {
  // Light DOM so global Tailwind utility classes apply to the markup
  // below without needing per-element style injection.
  createRenderRoot() {
    return this;
  }

  @state() private email = '';
  @state() private name = '';
  @state() private busy = false;
  @state() private done = false;
  @state() private error: string | null = null;

  private async submit(e: Event) {
    e.preventDefault();
    this.error = null;
    this.busy = true;
    try {
      const body: Record<string, unknown> = { email: this.email };
      if (this.name.trim()) body.name = this.name.trim();
      await api('/api/registration', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      this.done = true;
      this.email = '';
      this.name = '';
    } catch (err) {
      this.error = friendlyError(err, "Couldn't register — please try again.");
    } finally {
      this.busy = false;
    }
  }

  render() {
    if (this.done) {
      return html`
        <div class="card mx-auto max-w-sm p-6 text-center">
          <p class="text-base font-medium text-neutral-900">
            Thanks, you're registered!
          </p>
          <p class="mt-2 text-sm text-neutral-500">
            We'll be in touch.
          </p>
        </div>
      `;
    }

    return html`
      <form
        @submit=${this.submit}
        class="card mx-auto flex max-w-sm flex-col gap-3 p-6"
      >
        <div>
          <label for="reg-name" class="label">Name <span class="text-neutral-400">(optional)</span></label>
          <input
            id="reg-name"
            type="text"
            autocomplete="name"
            .value=${this.name}
            @input=${(e: Event) => (this.name = (e.target as HTMLInputElement).value)}
            placeholder="Jane Doe"
            class="input"
          />
        </div>
        <div>
          <label for="reg-email" class="label">Email</label>
          <input
            id="reg-email"
            type="email"
            required
            autocomplete="email"
            .value=${this.email}
            @input=${(e: Event) => (this.email = (e.target as HTMLInputElement).value)}
            placeholder="you@example.com"
            class="input"
          />
        </div>
        <button type="submit" ?disabled=${this.busy} class="btn-primary">
          ${this.busy ? 'Registering…' : 'Register'}
        </button>
        ${this.error
          ? html`<p class="text-sm text-red-600">${this.error}</p>`
          : nothing}
      </form>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'hy-registration': HyRegistration;
  }
}
