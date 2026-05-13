import { handle } from 'hono/aws-lambda';
import { resolveSecrets } from './secrets.js';
import { ensureDefaultRolesSeeded } from './auth/seedRoles.js';

// Cold-start init runs the slow setup in parallel so the first user
// request doesn't wait sequentially:
//   • resolveSecrets()             — one Secrets Manager Get if there are any
//                                     secret:// outputs to inject as env vars
//   • ensureDefaultRolesSeeded()    — idempotent upsert of the admin role row in
//                                     authRolesTable
//
// Both swallow errors (logged) rather than rejecting init — a transient
// failure here would otherwise 500 every request. The downstream code
// surfaces clear errors when it actually needs these resources.
//
// Note: there's no Aurora warmup here. The minimal template doesn't use
// Aurora. Projects that adopt the notes pattern re-introduce Aurora and
// re-add a warmupCluster() call to this Promise.all to absorb the cold-
// start delay before the first /api/notes request.
const ready = Promise.all([
  resolveSecrets(),
  ensureDefaultRolesSeeded().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[handler] cold-start role seed failed', err);
  }),
]);

let cached: ReturnType<typeof handle> | undefined;

export const handler = async (event: unknown, context: unknown) => {
  await ready;
  if (!cached) {
    const { app } = await import('./app.js');
    cached = handle(app);
  }
  // hono/aws-lambda handle() returns a function with this exact signature
  return (cached as (e: unknown, c: unknown) => Promise<unknown>)(event, context);
};
