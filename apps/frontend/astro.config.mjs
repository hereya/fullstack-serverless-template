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
export default defineConfig({
  output: 'static',
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
