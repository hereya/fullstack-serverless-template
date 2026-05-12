import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { createRef, ref, type Ref } from 'lit/directives/ref.js';
import { api, friendlyError } from '../lib/api';
import { DeferredLoadingController, skelBox } from '../lib/skeleton';

interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  downloadUrl: string;
}

interface UploadUrlResponse extends Attachment {
  uploadUrl: string;
}

// 25 MB — must match MAX_ATTACHMENT_BYTES on the backend. Sized for the
// demo Notes app (documents, screenshots). The browser → S3 direct PUT
// supports much larger files; bump this + the backend constant if your
// app actually needs media uploads.
const MAX_SIZE_BYTES = 25 * 1024 * 1024;

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

@customElement('hy-attachments')
export class HyAttachments extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: String, attribute: 'note-id' }) noteId = '';

  @state() private items: Attachment[] | null = null;
  @state() private busy = false;
  @state() private error: string | null = null;

  private fileInput: Ref<HTMLInputElement> = createRef();
  private loadingDelay = new DeferredLoadingController(this);

  updated(changed: Map<string, unknown>) {
    if (changed.has('noteId') && this.noteId) {
      void this.reload();
    }
  }

  private async reload() {
    try {
      const list = await api<Attachment[]>(
        `/api/notes/${this.noteId}/attachments`,
      );
      this.items = list;
    } catch (err) {
      this.error = friendlyError(err, "Couldn't load attachments.");
    }
  }

  private async onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    if (file.size > MAX_SIZE_BYTES) {
      this.error = `File too large (max ${humanSize(MAX_SIZE_BYTES)})`;
      return;
    }
    this.error = null;
    this.busy = true;
    try {
      // Step 1: ask the backend for a presigned PUT URL + a DB row.
      const presigned = await api<UploadUrlResponse>(
        `/api/notes/${this.noteId}/attachments/upload-url`,
        {
          method: 'POST',
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type || 'application/octet-stream',
            sizeBytes: file.size,
          }),
        },
      );

      // Step 2: upload the bytes directly to S3. credentials:'omit' is
      // important — the presigned URL already contains the auth signature,
      // and sending cookies would actually break the signature on some
      // S3 endpoints.
      const putRes = await fetch(presigned.uploadUrl, {
        method: 'PUT',
        body: file,
        credentials: 'omit',
        headers: { 'Content-Type': presigned.contentType },
      });
      if (!putRes.ok) {
        throw new Error(`Upload failed: ${putRes.status} ${putRes.statusText}`);
      }

      // Step 3: refresh the list (presigned GET URLs include the new file).
      await this.reload();
    } catch (err) {
      this.error = friendlyError(err, "Upload failed — please try again.");
    } finally {
      this.busy = false;
    }
  }

  private async remove(att: Attachment) {
    const prev = this.items ?? [];
    this.items = prev.filter((a) => a.id !== att.id);
    try {
      await api(`/api/notes/${this.noteId}/attachments/${att.id}`, {
        method: 'DELETE',
      });
    } catch (err) {
      this.error = friendlyError(err, "Couldn't delete the attachment.");
      this.items = prev;
    }
  }

  // Skeleton for the file-list before the first GET resolves. Two rows
  // matches the visual rhythm of the loaded list without lying about
  // the actual attachment count.
  private renderSkeleton(): TemplateResult {
    return html`
      <ul class="space-y-1 animate-pulse">
        ${[0, 1].map(
          () => html`
            <li
              class="flex items-center gap-2 rounded border border-neutral-200 bg-neutral-50 px-3 py-1.5"
            >
              ${skelBox('h-4 flex-1', 'secondary')}
              ${skelBox('h-3 w-12 shrink-0', 'secondary')}
            </li>
          `,
        )}
      </ul>
    `;
  }

  render() {
    return html`
      <div class="space-y-2">
        <div class="flex items-center gap-2">
          <input
            ${ref(this.fileInput)}
            type="file"
            @change=${this.onPick}
            ?disabled=${this.busy}
            class="hidden"
          />
          <button
            type="button"
            @click=${() => this.fileInput.value?.click()}
            ?disabled=${this.busy}
            class="btn-secondary"
          >
            ${this.busy ? 'Uploading…' : 'Attach a file'}
          </button>
          <span class="text-xs text-neutral-400">
            Up to ${humanSize(MAX_SIZE_BYTES)}
          </span>
        </div>

        ${this.error
          ? html`<p class="text-sm text-red-600">${this.error}</p>`
          : nothing}
        ${
          // Mutually exclusive: render skeleton OR list. Without the
          // !holdSkeleton gate on the second branch, a fetch that
          // resolves inside the min-visible window would paint both at
          // once until the controller released.
          this.items === null || this.loadingDelay.holdSkeleton
            ? this.loadingDelay.deferred(this.renderSkeleton())
            : this.items.length > 0
              ? html`
                  <ul class="space-y-1">
                    ${this.items.map(
                      (a) => html`
                        <li
                          class="flex items-center gap-2 rounded border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-sm"
                        >
                          <a
                            href=${a.downloadUrl}
                            target="_blank"
                            rel="noreferrer"
                            class="flex-1 truncate font-medium text-blue-600 hover:underline"
                            download=${a.filename}
                          >
                            ${a.filename}
                          </a>
                          <span class="shrink-0 text-xs text-neutral-500">
                            ${humanSize(a.sizeBytes)}
                          </span>
                          <button
                            type="button"
                            @click=${() => this.remove(a)}
                            class="shrink-0 text-xs text-red-600 hover:underline"
                            aria-label="Delete attachment ${a.filename}"
                          >
                            Remove
                          </button>
                        </li>
                      `,
                    )}
                  </ul>
                `
              : nothing
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'hy-attachments': HyAttachments;
  }
}
