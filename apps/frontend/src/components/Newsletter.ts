import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { api, friendlyError } from '../lib/api';

// Public newsletter signup. No auth, no caching — single POST to
// /api/newsletter then a success message in place of the form.
@customElement('hy-newsletter')
export class HyNewsletter extends LitElement {
  // Light DOM so global Tailwind utility classes apply to the markup
  // below without needing per-element style injection.
  createRenderRoot() {
    return this;
  }

  @state() private email = '';
  @state() private busy = false;
  @state() private done = false;
  @state() private error: string | null = null;

  private async submit(e: Event) {
    e.preventDefault();
    this.error = null;
    this.busy = true;
    try {
      await api('/api/newsletter', {
        method: 'POST',
        body: JSON.stringify({ email: this.email }),
      });
      this.done = true;
      this.email = '';
    } catch (err) {
      this.error = friendlyError(err, "Couldn't subscribe — please try again.");
    } finally {
      this.busy = false;
    }
  }

  private onEmailInput(e: Event) {
    this.email = (e.target as HTMLInputElement).value;
  }

  render() {
    if (this.done) {
      return html`
        <div class="card mx-auto max-w-sm p-6 text-center">
          <p class="text-base font-medium text-neutral-900">
            Thanks, you're on the list!
          </p>
          <p class="mt-2 text-sm text-neutral-500">
            We'll send you something worth your inbox.
          </p>
        </div>
      `;
    }

    return html`
      <form
        @submit=${this.submit}
        class="card mx-auto flex max-w-sm items-end gap-2 p-6"
      >
        <div class="flex-1">
          <label for="newsletter-email" class="label">Email</label>
          <input
            id="newsletter-email"
            type="email"
            required
            autocomplete="email"
            .value=${this.email}
            @input=${this.onEmailInput}
            placeholder="you@example.com"
            class="input"
          />
        </div>
        <button type="submit" ?disabled=${this.busy} class="btn-primary">
          ${this.busy ? 'Subscribing…' : 'Subscribe'}
        </button>
        ${this.error
          ? html`<p class="mt-2 w-full text-sm text-red-600">${this.error}</p>`
          : nothing}
      </form>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'hy-newsletter': HyNewsletter;
  }
}
