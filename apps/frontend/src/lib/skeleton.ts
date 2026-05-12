// Shared loading-skeleton primitives. Every component's loading state
// is built from these so the visual language stays consistent across
// pages: lighter-grey blocks for inputs/secondary, darker for primary
// labels, all wrapped in `animate-pulse` for the subtle breathing motion.
//
// Why composable primitives over per-component bespoke skeletons:
//   • One place to tweak rounding/colors if the design changes.
//   • Each consumer picks the layout that mirrors its loaded markup,
//     so the page reflows minimally when real data lands.
//   • Stays inline-template-friendly — these return `TemplateResult`s
//     that compose cleanly with the surrounding html`...` in each
//     Lit element's render(). No new custom elements registered.

import {
  html,
  nothing,
  type ReactiveController,
  type ReactiveControllerHost,
  type TemplateResult,
} from 'lit';

// -----------------------------------------------------------------------
// Deferred-skeleton controller.
//
// Naïvely showing a skeleton on mount produces a flicker whenever the
// underlying fetch resolves in <100 ms — skeleton flashes in, immediately
// gets replaced by content. Moving the threshold (e.g. "only show
// after 200 ms") just relocates the cliff: a fetch that lands at 210 ms
// flashes a 10-ms skeleton.
//
// Fix is two-fold:
//
//   1. delayMs (default 200 ms): don't render the skeleton at all until
//      this window has elapsed. Anything finishing inside it goes
//      `nothing → content`, perceived as "the page just loaded."
//      Material guidelines call <200 ms "instant" — no feedback needed.
//
//   2. minVisibleMs (default 300 ms): once the skeleton DOES appear,
//      hold it for at least this long even if the fetch finishes earlier.
//      Eliminates the boundary flash at delayMs+epsilon.
//
// Combined timing for any fetch duration:
//
//   fetch <= 200 ms    → empty <= 200 ms → content
//   fetch in 200–500   → empty 200 → skeleton ≥300 → content
//   fetch > 500 ms     → empty 200 → skeleton (fetch-200) → content
//
// Usage inside a Lit element:
//
//     class MyEl extends LitElement {
//       private loadingDelay = new DeferredLoadingController(this);
//       render() {
//         if (this.loading || this.loadingDelay.holdSkeleton) {
//           return this.loadingDelay.deferred(this.renderSkeleton());
//         }
//         return this.renderContent();
//       }
//     }
// -----------------------------------------------------------------------

export class DeferredLoadingController implements ReactiveController {
  private host: ReactiveControllerHost;
  private showTimer: number | undefined;
  private releaseTimer: number | undefined;

  // True once `delayMs` has elapsed since connect — the skeleton MAY now
  // be drawn (the consuming element still has to decide it's loading).
  private shown = false;

  // True once `minVisibleMs` has elapsed since `shown` flipped — the
  // consuming element is now free to render content even if it became
  // ready earlier.
  private released = false;

  constructor(
    host: ReactiveControllerHost,
    public delayMs = 200,
    public minVisibleMs = 300,
  ) {
    this.host = host;
    host.addController(this);
  }

  hostConnected(): void {
    if (typeof window === 'undefined') return;
    this.shown = false;
    this.released = false;
    this.showTimer = window.setTimeout(() => {
      this.shown = true;
      this.host.requestUpdate();
      this.releaseTimer = window.setTimeout(() => {
        this.released = true;
        this.host.requestUpdate();
      }, this.minVisibleMs);
    }, this.delayMs);
  }

  hostDisconnected(): void {
    if (this.showTimer !== undefined) clearTimeout(this.showTimer);
    if (this.releaseTimer !== undefined) clearTimeout(this.releaseTimer);
    this.showTimer = undefined;
    this.releaseTimer = undefined;
  }

  // Returns the passed-in skeleton once the deferred window has elapsed,
  // and `nothing` before that. Designed to be inlined at the call site
  // so the loading branch reads as a single expression.
  deferred(skeleton: TemplateResult): TemplateResult | typeof nothing {
    return this.shown ? skeleton : nothing;
  }

  // True ONLY in the window between "skeleton has appeared" and
  // "minimum-visible has elapsed." Consuming components OR this into
  // their loading condition so a fast-but-not-instant fetch still gets
  // a full skeleton tick instead of flickering.
  get holdSkeleton(): boolean {
    return this.shown && !this.released;
  }
}


// Single pulsing block. Pass full Tailwind utility strings (w-…, h-…)
// rather than props so the call site reads like the markup it mimics.
// `tone` picks the contrast — `primary` is heading-weight, `secondary`
// is body-text/input-weight.
export function skelBox(
  classes: string,
  tone: 'primary' | 'secondary' = 'primary',
): TemplateResult {
  const bg = tone === 'primary' ? 'bg-neutral-200' : 'bg-neutral-100';
  return html`<div class="rounded ${bg} ${classes}"></div>`;
}

// A line for page titles — sized like an h1 placeholder.
export const skelTitle = (w = 'w-32'): TemplateResult =>
  skelBox(`h-8 ${w}`);

// A short caption / helper-text line.
export const skelLineSmall = (w = 'w-full'): TemplateResult =>
  skelBox(`h-3 ${w}`, 'secondary');

// A regular body line.
export const skelLine = (w = 'w-full'): TemplateResult =>
  skelBox(`h-4 ${w}`, 'secondary');

// An input-sized rectangle.
export const skelInput = (): TemplateResult => skelBox('h-10 w-full', 'secondary');

// A button-sized rectangle.
export const skelButton = (w = 'w-24'): TemplateResult =>
  skelBox(`h-9 ${w}`);

// Card-shaped container that owns the `animate-pulse` so callers don't
// have to remember it. Pass the inner skeleton arrangement as children.
export function skelCard(
  inner: TemplateResult | TemplateResult[],
): TemplateResult {
  return html`
    <div class="card space-y-3 p-4 animate-pulse">${inner}</div>
  `;
}

// Table skeleton (header row + N data rows × M cols). Used by the admin
// list pages. Header bg + dividers match the loaded table.
export function skelTable(rows = 4, cols = 4): TemplateResult {
  const cells = (extra: string) =>
    Array.from(
      { length: cols },
      () => html`<div class="rounded bg-neutral-100 ${extra}"></div>`,
    );
  return html`
    <div class="card overflow-hidden animate-pulse">
      <div class="bg-neutral-50 px-4 py-3">
        <div
          class="grid gap-4"
          style="grid-template-columns: repeat(${cols}, minmax(0, 1fr))"
        >
          ${cells('h-3')}
        </div>
      </div>
      <div class="divide-y divide-neutral-200">
        ${Array.from(
          { length: rows },
          () => html`
            <div class="px-4 py-3">
              <div
                class="grid gap-4"
                style="grid-template-columns: repeat(${cols}, minmax(0, 1fr))"
              >
                ${cells('h-4')}
              </div>
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

// Pre-baked "form card" skeleton (label + input + submit). Used by the
// login flow and any other single-field form before its data is ready.
export function skelFormCard(): TemplateResult {
  return html`
    <div class="card mx-auto max-w-sm p-6 space-y-4 animate-pulse">
      ${skelLine('w-16')} ${skelInput()} ${skelButton('w-full')}
    </div>
  `;
}
