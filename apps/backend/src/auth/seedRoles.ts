// Cold-start role bootstrap. Called from handler.ts (Lambda) and dev-
// server.ts (local) so the authRolesTable always has at least the
// default admin role before any request handler runs.
//
// Admin is force-overwritten to ALL_PERMISSIONS on every cold start.
// The semantic of "admin" is "every permission the app currently
// defines", so adding a new permission constant in permissions.ts
// must propagate to admins without a manual update step. The
// createdAt of an existing row is preserved.
//
// The minimal template ships only the admin role. Projects that want a
// distinct "member" role with a curated subset of permissions can add
// it here — the upsertRoleIfMissing helper is the right tool (seeds
// only when absent; a future admin UI can grant/revoke without those
// edits being clobbered on next cold start).
//
// Failures are logged but don't fail init.

import { ALL_PERMISSIONS, invalidateRoleCache } from './permissions.js';
import { upsertRoleOverwrite } from './roles.js';

let seedPromise: Promise<void> | null = null;

export function ensureDefaultRolesSeeded(): Promise<void> {
  if (!seedPromise) {
    seedPromise = (async () => {
      await upsertRoleOverwrite(
        'admin',
        ALL_PERMISSIONS,
        'Administrator — all permissions, including managing other users',
      );
      // Drop any in-flight role-permission cache entries: if a previous
      // cold start cached the OLD admin permissions, a new permission
      // we just added wouldn't be visible until the 60s TTL.
      invalidateRoleCache();
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[seedRoles] default-role seed failed:', err);
      // Reset so a later invocation retries instead of caching the failure.
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}
