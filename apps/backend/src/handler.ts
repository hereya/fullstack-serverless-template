import { handle } from 'hono/aws-lambda';
import { resolveSecrets } from './secrets.js';
import { warmupCluster, isTransient } from './db/resilience.js';
import { ensureDefaultRolesSeeded } from './auth/seedRoles.js';

// Cold-start init runs all the slow setup in parallel so the first user
// request doesn't wait sequentially:
//   • resolveSecrets()             — one Secrets Manager Get if there are any
//                                     secret:// outputs to inject as env vars
//   • warmupCluster()               — wakes Aurora Serverless v2 (paused →
//                                     active) with retry, so the first /api/notes
//                                     request doesn't pay the resume delay
//   • ensureDefaultRolesSeeded()    — idempotent Put of admin + member rows in
//                                     authRolesTable; condition_not_exists so
//                                     manual edits to a role's permission set
//                                     are NEVER overwritten by a re-seed
//
// All three swallow errors (logged) rather than rejecting init — a transient
// failure here would otherwise 500 every request. The downstream code surfaces
// clear errors when it actually needs these resources.
const ready = Promise.all([
  resolveSecrets(),
  warmupCluster().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(
      `[handler] cold-start warmup failed (${
        isTransient(err) ? 'transient' : 'non-transient'
      }) — will fall back to per-request retry`,
      err,
    );
  }),
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
