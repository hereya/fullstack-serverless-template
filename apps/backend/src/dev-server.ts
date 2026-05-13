import { serve } from '@hono/node-server';
import { app } from './app.js';
import { ensureDefaultRolesSeeded } from './auth/seedRoles.js';

const port = Number(process.env.PORT ?? 4000);

// Mirror handler.ts cold-start: kick the role seed in the background at
// startup so the authRolesTable has the admin row before the first
// request. Listening starts immediately so dev-server.ts doesn't block.
ensureDefaultRolesSeeded().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.warn('[dev-server] default-role seed failed', err);
});

serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`backend listening on http://localhost:${info.port}`);
});
