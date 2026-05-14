# Pattern: Open Graph share previews

The template ships with reasonable defaults for link-preview cards on
Slack, Discord, WhatsApp, X/Twitter, LinkedIn, iMessage, etc. This
pattern explains:

- What's already in place (so you don't break it)
- How to customize the OG image per project
- How to override per-page

## What ships by default

- `apps/frontend/public/og-image.png` — 1200×630 PNG, hereya-branded
  "serverless template" placeholder. Replace this file to change the
  default OG image for the whole site.
- `apps/frontend/public/favicon.svg` — hereya-branded favicon (red
  serif "h" on dark navy).
- `scripts/og-card.html` — the source HTML for the OG image. Edit
  this and re-render to regenerate.
- `apps/frontend/src/layouts/Base.astro` emits the full meta-tag suite:
  - `og:type/url/site_name/locale/title/description/image`
  - `og:image:width=1200/height=630/type=png/alt`
  - `twitter:card=summary_large_image` + matching title/description/image
  - `theme-color=#1A1A2E` (mobile browser chrome)
  - `<link rel="canonical">` and `<link rel="icon" type="image/svg+xml">`
- `apps/frontend/astro.config.mjs` reads `process.env.appUrl` (injected
  by `hereya/aws-app-lambda` at deploy) into Astro's `site:` config so
  all OG / canonical URLs are absolute. No per-project edit needed.

## Customize the OG image for your project

### 1. Edit the design

Open `scripts/og-card.html` in any browser to preview your edits live.
Tweak the title, badge, subtitle, meta line, colors — it's plain HTML +
CSS. Three knobs cover most projects:

```html
<!-- The top-left site label -->
<div class="site">your-project · short-tagline</div>

<!-- Pill above the headline -->
<div class="badge">Static · Registration · Admin · MCP-ready</div>

<!-- The big headline -->
<h1 class="title">Build your app <em>in your AI.</em></h1>

<!-- The supporting paragraph -->
<p class="subtitle">...</p>

<!-- The bottom meta row -->
<div class="meta">
  <span class="meta-item">Astro + Hono + Lambda</span>
  ...
</div>
```

### 2. Regenerate the PNG

Chrome headless renders the HTML at exactly 1200×630 and screenshots it
into the public folder. macOS / Linux:

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars \
  --window-size=1200,630 \
  --screenshot=apps/frontend/public/og-image.png \
  "file://$(pwd)/scripts/og-card.html"

# Linux (Chrome or Chromium)
google-chrome --headless --disable-gpu --hide-scrollbars \
  --window-size=1200,630 \
  --screenshot=apps/frontend/public/og-image.png \
  "file://$(pwd)/scripts/og-card.html"
```

The PNG is ~150–200 KB at this size — well under the 8 MB ceiling
every platform enforces, and small enough for instant scraping.

### 3. (Optional) Add a build-time check

If you want to fail the build when og-card.html and og-image.png drift
out of sync, drop a script in `scripts/check-og.sh` that compares
mtimes or content hashes — invoke it from the frontend `prebuild`
script. The minimal template doesn't include this because the OG image
is intentionally hand-curated, not auto-generated.

## Override per page

`Base.astro` accepts OG props. Any page that wraps `Base` can pass its
own title, description, image:

```astro
---
import Base from '../layouts/Base.astro';
---
<Base
  title="My specific page title"
  description="Distinct description for this page's preview card."
  ogImage="/og-page-blog.png"
>
  ...content...
</Base>
```

`ogImage` accepts a path (resolved against the site origin) or an
absolute URL.

## Override the layout entirely (project-specific)

If a project ships its own layout that doesn't use `Base.astro` — like
`webinar-ai-june`'s `WebinarLayout.astro` which has fully bespoke
hero markup — replicate the meta-tag block from `Base.astro` inside
that layout. The `Astro.site` config still works, so absolute URL
building is identical.

## Validate after deploy

Each platform caches OG metadata aggressively. After deploying a
change, use the platform debuggers to force a re-scrape:

| Platform | Debugger |
|---|---|
| Facebook / WhatsApp / Instagram | `https://developers.facebook.com/tools/debug/` |
| LinkedIn | `https://www.linkedin.com/post-inspector/` |
| X / Twitter | DM the URL to yourself; X usually re-scrapes within seconds |
| Slack | DM the URL to yourself; if cached, the `/debug` slash command can clear |
| Discord | DM the URL to yourself; Discord caches ~12h, hard to force-clear |
| iMessage | New conversation thread re-fetches; existing threads keep the old card |

If you don't see a preview at all, the most common causes are:

1. **`og:image` is a relative URL** — must be absolute (`https://...`)
2. **The image is behind auth / a redirect** — scrapers don't follow
   3xx and don't have cookies. Serve the OG image from a public,
   directly-fetchable path.
3. **Mixed content** — if your site is HTTPS, the OG image URL must be
   HTTPS too.
4. **CDN cache** — if you replaced og-image.png but the platform sees
   a 304 from CloudFront, the new image won't propagate. Use the
   platform debugger to force a fresh fetch.
5. **The image is too big** — keep under 5 MB to be safe.

## What's NOT in scope of this pattern

- **Dynamic per-page OG images.** If you want each blog post to have
  its own OG card with the post title rendered in, you need build-time
  rendering (e.g. `@vercel/og` + `satori`, or running the Chrome-
  headless command in a per-post loop). The minimal template doesn't
  ship that — apply this pattern as a starting point and grow it if
  your project needs it.
- **OG image for the admin pages.** They're behind the inline auth
  gate; nobody shares `/admin/*` URLs publicly. The defaults from
  Base.astro still apply, but no project-specific design is needed.
