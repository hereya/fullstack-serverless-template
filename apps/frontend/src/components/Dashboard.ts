import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { api, friendlyError } from '../lib/api';
import {
  DeferredLoadingController,
  skelBox,
  skelButton,
  skelInput,
  skelLine,
  skelLineSmall,
  skelTitle,
} from '../lib/skeleton';
// Side-effect import: registers <hy-attachments>. Composed inside each
// note card via the custom element tag below.
import './Attachments';

interface Me {
  email: string;
  sub: string;
}

interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

@customElement('hy-dashboard')
export class HyDashboard extends LitElement {
  createRenderRoot() {
    return this;
  }

  // While we're still figuring out the auth state and fetching notes, render
  // a skeleton that matches the real layout so the page doesn't pop in
  // staged chunks. The skeleton ships in the SSR HTML (via @astrojs/lit),
  // so the user sees structure immediately — no blank flash before the
  // client takes over. Unauthenticated visitors briefly see the skeleton
  // before the 401 → /login redirect; acceptable tradeoff for the much
  // better authenticated-load UX.
  @state() private me: Me | null = null;
  @state() private notes: Note[] = [];
  @state() private title = '';
  @state() private body = '';
  @state() private loading = true;
  @state() private error: string | null = null;

  private loadingDelay = new DeferredLoadingController(this);

  async firstUpdated() {
    try {
      const m = await api<Me>('/api/auth/me');
      this.me = m;
      const list = await api<Note[]>('/api/notes');
      this.notes = list;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('401')) {
        window.location.replace('/login?next=/dashboard');
        return;
      }
      this.error = friendlyError(err, "Couldn't load your notes.");
    } finally {
      this.loading = false;
    }
  }

  private async createNote(e: Event) {
    e.preventDefault();
    try {
      const note = await api<Note>('/api/notes', {
        method: 'POST',
        body: JSON.stringify({ title: this.title, body: this.body }),
      });
      this.notes = [note, ...this.notes];
      this.title = '';
      this.body = '';
    } catch (err) {
      this.error = friendlyError(err, "Couldn't create the note.");
    }
  }

  private async deleteNote(id: string) {
    try {
      await api(`/api/notes/${id}`, { method: 'DELETE' });
      this.notes = this.notes.filter((n) => n.id !== id);
    } catch (err) {
      this.error = friendlyError(err, "Couldn't delete the note.");
    }
  }

  private renderSkeleton(): TemplateResult {
    return html`
      <div class="space-y-6 animate-pulse">
        ${skelTitle('w-24')}

        <div class="card space-y-3 p-4">
          ${skelLine('w-24')} ${skelInput()} ${skelInput()}
          <div class="flex justify-end">${skelButton()}</div>
        </div>

        ${[0, 1].map(
          () => html`
            <div class="card space-y-3 p-4">
              <div class="flex items-start justify-between gap-4">
                <div class="min-w-0 flex-1 space-y-2">
                  ${skelBox('h-5 w-1/2')} ${skelLine('w-3/4')}
                  ${skelLineSmall('w-32')}
                </div>
                ${skelBox('h-8 w-20 shrink-0')}
              </div>
              ${skelBox('h-9 w-32', 'secondary')}
            </div>
          `,
        )}
      </div>
    `;
  }

  render() {
    if (this.loading || !this.me || this.loadingDelay.holdSkeleton) {
      return this.loadingDelay.deferred(this.renderSkeleton());
    }

    return html`
      <div class="space-y-6">
        <h1>Notes</h1>
        ${this.error
          ? html`
              <div
                class="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
              >
                ${this.error}
              </div>
            `
          : nothing}

        <form @submit=${this.createNote} class="card space-y-3 p-4">
          <h2
            class="text-sm font-semibold uppercase tracking-wide text-neutral-500"
          >
            New note
          </h2>
          <input
            placeholder="Title"
            .value=${this.title}
            @input=${(e: Event) => {
              this.title = (e.target as HTMLInputElement).value;
            }}
            required
            class="input"
          />
          <input
            placeholder="Body"
            .value=${this.body}
            @input=${(e: Event) => {
              this.body = (e.target as HTMLInputElement).value;
            }}
            class="input"
          />
          <div class="flex justify-end">
            <button type="submit" class="btn-primary">Add note</button>
          </div>
        </form>

        ${this.notes.length === 0
          ? html`
              <p class="text-sm text-neutral-500">
                No notes yet. Create your first one above.
              </p>
            `
          : html`
              <ul class="space-y-3">
                ${this.notes.map(
                  (n) => html`
                    <li class="card space-y-3 p-4">
                      <div class="flex items-start justify-between gap-4">
                        <div class="min-w-0 flex-1">
                          <h3
                            class="truncate text-base font-medium text-neutral-900"
                          >
                            ${n.title}
                          </h3>
                          ${n.body
                            ? html`<p
                                class="mt-1 text-sm text-neutral-600"
                              >
                                ${n.body}
                              </p>`
                            : nothing}
                          <p class="mt-2 text-xs text-neutral-400">
                            ${new Date(n.createdAt).toLocaleString()}
                          </p>
                        </div>
                        <button
                          @click=${() => this.deleteNote(n.id)}
                          class="btn-danger shrink-0"
                          aria-label="Delete note &quot;${n.title}&quot;"
                        >
                          Delete
                        </button>
                      </div>
                      <hy-attachments note-id=${n.id}></hy-attachments>
                    </li>
                  `,
                )}
              </ul>
            `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'hy-dashboard': HyDashboard;
  }
}
