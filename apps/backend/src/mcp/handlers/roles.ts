// Shared role-management handlers. Roles + their permission sets live
// in DDB (see auth/roles.ts). These handlers are READ + DATA-MUTATE
// only — they never touch DDB *schema* (e.g., a new GSI). MCP-side
// schema-immutability extends here: tools may CHANGE a role's
// permissions but may NOT introduce new role tables or columns.

import {
  getRole,
  listRoles,
  updateRolePermissions,
  type RoleRow,
} from '../../auth/roles.js';
import { invalidateRoleCache } from '../../auth/permissions.js';

export interface RoleView {
  roleName: string;
  description?: string;
  permissions: string[];
  createdAt: Date | string;
}

function toView(r: RoleRow): RoleView {
  return {
    roleName: r.roleName,
    description: r.description,
    permissions: Array.from(r.permissions).sort(),
    createdAt: r.createdAt,
  };
}

export async function listRolesHandler(): Promise<RoleView[]> {
  const rows = await listRoles();
  return rows.map(toView);
}

export class RoleNotFoundError extends Error {
  constructor(name: string) {
    super(`role ${name} not found`);
    this.name = 'RoleNotFoundError';
  }
}

export async function updateRolePermissionsHandler(opts: {
  roleName: string;
  permissions: string[];
}): Promise<RoleView> {
  const existing = await getRole(opts.roleName);
  if (!existing) throw new RoleNotFoundError(opts.roleName);

  // Dedupe + canonicalize. The DDB writer takes a readonly string[].
  const next = Array.from(new Set(opts.permissions));
  await updateRolePermissions(opts.roleName, next);

  // Drop the per-Lambda cache entry so the new permissions are visible
  // on the very next request. Without this the 60s TTL would mean a
  // confusing "I updated permissions but they're not taking effect" UX.
  invalidateRoleCache(opts.roleName);

  const updated = await getRole(opts.roleName);
  if (!updated) throw new RoleNotFoundError(opts.roleName);
  return toView(updated);
}
