// RBAC for the app.
//
// Permission identifiers are CODE constants — that gives you type safety at
// every call site (`requirePermission('users:list')` won't compile if you
// typo'd it). The actual grants are STATE: each role's permission set lives
// as a row in DynamoDB's authRolesTable. Default role definitions are
// seeded into DDB on backend cold start (see seedRoles.ts). An admin can
// later mutate role definitions (e.g. via a future admin UI) without a
// code change.
//
// Why this split:
//   • Type-safe permission references in code → can't ship a typo'd gate.
//   • Role->permissions mapping in data → admin can re-tune permissions
//     without redeploys, and `ALL_PERMISSIONS` is derived so the admin role
//     automatically gains every newly-defined permission you ship.

import { getRole } from './roles.js';

export const PERMISSIONS = {
  USERS_LIST: 'users:list',
  USERS_ADD: 'users:add',
  USERS_SUSPEND: 'users:suspend',
  NEWSLETTER_LIST: 'newsletter:list',
  NOTES_READ_OWN: 'notes:read:own',
  NOTES_WRITE_OWN: 'notes:write:own',

  // MCP — see docs/mcp.md. `MCP_CONNECT` gates the OAuth consent step
  // (a user without it can't authorize an MCP client at all). Per-tool
  // permissions below gate individual tool calls; the bearer-token
  // middleware doesn't check any role — every tool is its own decision.
  MCP_CONNECT: 'mcp:connect',
  ROLES_LIST: 'roles:list',
  ROLES_UPDATE: 'roles:update',
  STATS_VIEW: 'stats:view',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// Derived from PERMISSIONS so admin automatically gets any newly-added
// permission you define without remembering to update a hand-listed array.
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

// Default member: own-notes only.
export const MEMBER_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.NOTES_READ_OWN,
  PERMISSIONS.NOTES_WRITE_OWN,
];

// In-memory role-cache. Bounded by the Lambda's warm lifetime; refreshes
// every 60s so role-permission mutations propagate within ~1 min. Lookup
// is per-Lambda-instance — a fleet-wide invalidation isn't needed: each
// instance independently refreshes within TTL.
interface CacheEntry {
  perms: Set<string>;
  fetchedAt: number;
}
const roleCache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

export async function roleHasPermission(
  roleName: string,
  p: Permission,
): Promise<boolean> {
  const cached = roleCache.get(roleName);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return cached.perms.has(p);
  }
  const role = await getRole(roleName);
  if (!role) {
    // Unknown role → deny. Cache the negative to avoid a DDB call per
    // request for a misconfigured user; gets re-checked after TTL.
    roleCache.set(roleName, { perms: new Set(), fetchedAt: Date.now() });
    return false;
  }
  roleCache.set(roleName, { perms: role.permissions, fetchedAt: Date.now() });
  return role.permissions.has(p);
}

// Test/admin hook: drop a single cached role so the next lookup refetches.
// Useful right after `updateRolePermissions` to make changes visible
// without waiting for the TTL.
export function invalidateRoleCache(roleName?: string): void {
  if (roleName) roleCache.delete(roleName);
  else roleCache.clear();
}
