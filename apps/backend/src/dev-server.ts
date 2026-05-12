import { serve } from '@hono/node-server';
import { app } from './app.js';
import { warmupCluster, isTransient } from './db/resilience.js';
import { ensureDefaultRolesSeeded } from './auth/seedRoles.js';

const port = Number(process.env.PORT ?? 4000);

// Fire warmup + role-seed in the background at startup, mirroring what
// handler.ts does on Lambda cold start. Listening starts immediately so
// dev-server.ts doesn't block.
warmupCluster().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.warn(
    `[dev-server] cluster warmup at startup failed (${
      isTransient(err) ? 'transient' : 'non-transient'
    }) — first request will pay the resume cost`,
    err,
  );
});

ensureDefaultRolesSeeded().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.warn('[dev-server] default-role seed failed', err);
});

serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`backend listening on http://localhost:${info.port}`);
});
