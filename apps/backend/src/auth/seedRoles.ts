// Cold-start role bootstrap. Called from handler.ts (Lambda) and dev-
// server.ts (local) so the authRolesTable always has at least the default
// roles before any request handler runs.
//
// Behavior differs by role:
//
//   • admin  → ALWAYS force-overwritten to ALL_PERMISSIONS. The semantic
//              of "admin" is "every permission the app currently defines",
//              so adding a new permission constant in permissions.ts must
//              propagate to admins without a manual update step. The
//              createdAt of an existing row is preserved.
//   • member → seeded ONLY when missing. Once present, never overwritten —
//              a future admin UI can grant/revoke permissions on the
//              member role without those edits being clobbered.
//
// Failures are logged but don't fail init.

import {
  ALL_PERMISSIONS,
  MEMBER_PERMISSIONS,
  invalidateRoleCache,
} from './permissions.js';
import { upsertRoleIfMissing, upsertRoleOverwrite } from './roles.js';

let seedPromise: Promise<void> | null = null;

export function ensureDefaultRolesSeeded(): Promise<void> {
  if (!seedPromise) {
    seedPromise = (async () => {
      await upsertRoleOverwrite(
        'admin',
        ALL_PERMISSIONS,
        'Administrator — all permissions, including managing other users',
      );
      await upsertRoleIfMissing(
        'member',
        MEMBER_PERMISSIONS,
        'Member — access to their own notes',
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
