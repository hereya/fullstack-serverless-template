// @ts-check
import { defineConfig } from 'astro/config';
import lit from '@astrojs/lit';
import tailwindcss from '@tailwindcss/vite';

// Lit instead of React: vanilla web-component story with a ~5 KB runtime
// (vs React + ReactDOM ~42 KB). @astrojs/lit ships SSR of element markup
// via @lit-labs/ssr, so the first HTML payload already contains the
// loading skeleton / public-nav shell — same no-flash first paint as
// React, smaller bundle.
//
// All Lit elements in this project use Light DOM (createRenderRoot
// returns `this`) so global Tailwind utilities apply to their internal
// markup. That keeps the conversion 1:1 with the prior React class
// lists and avoids the usual web-components × Tailwind friction.
// Canonical site URL — used by Astro for absolute URL building, and by
// Base.astro to emit OG / Twitter Card meta tags with absolute `og:url`
// and `og:image` values (required: link-preview scrapers don't resolve
// relative URLs). Comes from `appUrl` injected by hereya/aws-app-lambda
// at deploy time. Falls back to a dev placeholder so `npm run build`
// works locally without env. Each project's deploy auto-supplies the
// right value — no per-project edit needed.
const siteUrl =
  process.env.appUrl ??
  process.env.PUBLIC_SITE_URL ??
  'http://localhost:4321';

export default defineConfig({
  output: 'static',
  site: siteUrl,
  integrations: [lit()],
  vite: {
    plugins: [tailwindcss()],
    server: {
      proxy: {
        // The dev server forwards backend routes to the Hono process
        // on :4000 so the browser sees a single-origin world that
        // mirrors what CloudFront serves in production. The MCP +
        // OAuth routes need their own entries because they live
        // outside /api/* (per the MCP auth spec).
        '/api': { target: 'http://localhost:4000', changeOrigin: true },
        '/mcp': { target: 'http://localhost:4000', changeOrigin: true },
        '/oauth': { target: 'http://localhost:4000', changeOrigin: true },
        '/.well-known': {
          target: 'http://localhost:4000',
          changeOrigin: true,
        },
      },
    },
  },
});
