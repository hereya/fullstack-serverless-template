import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.authRolesTableName = 'auth-roles-table';

// We're testing the cache + lookup logic in permissions.ts; mock the
// underlying DDB layer (auth/roles.ts).
const rolesSpies = {
  getRole: vi.fn(),
  listRoles: vi.fn(),
  upsertRoleIfMissing: vi.fn(),
  updateRolePermissions: vi.fn(),
};
vi.mock('../src/auth/roles.js', () => ({
  getRole: (...a: unknown[]) => rolesSpies.getRole(...a),
  listRoles: (...a: unknown[]) => rolesSpies.listRoles(...a),
  upsertRoleIfMissing: (...a: unknown[]) => rolesSpies.upsertRoleIfMissing(...a),
  updateRolePermissions: (...a: unknown[]) =>
    rolesSpies.updateRolePermissions(...a),
}));

import {
  ALL_PERMISSIONS,
  MEMBER_PERMISSIONS,
  PERMISSIONS,
  invalidateRoleCache,
  roleHasPermission,
} from '../src/auth/permissions.js';

describe('PERMISSIONS / ALL_PERMISSIONS', () => {
  it('ALL_PERMISSIONS contains every value in PERMISSIONS (admin auto-gets new permissions)', () => {
    const defined = Object.values(PERMISSIONS);
    expect(ALL_PERMISSIONS.length).toBe(defined.length);
    for (const p of defined) {
      expect(ALL_PERMISSIONS).toContain(p);
    }
  });

  it('MEMBER_PERMISSIONS is a strict subset of ALL_PERMISSIONS', () => {
    for (const p of MEMBER_PERMISSIONS) {
      expect(ALL_PERMISSIONS).toContain(p);
    }
    expect(MEMBER_PERMISSIONS.length).toBeLessThan(ALL_PERMISSIONS.length);
  });

  it('MEMBER_PERMISSIONS does NOT grant any users:* permission', () => {
    expect(MEMBER_PERMISSIONS).not.toContain(PERMISSIONS.USERS_LIST);
    expect(MEMBER_PERMISSIONS).not.toContain(PERMISSIONS.USERS_ADD);
    expect(MEMBER_PERMISSIONS).not.toContain(PERMISSIONS.USERS_SUSPEND);
  });
});

describe('roleHasPermission', () => {
  beforeEach(() => {
    Object.values(rolesSpies).forEach((m) => m.mockReset());
    invalidateRoleCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when the role grants the permission (and caches it)', async () => {
    rolesSpies.getRole.mockResolvedValue({
      roleName: 'admin',
      permissions: new Set<string>(Object.values(PERMISSIONS)),
      createdAt: '2025-01-01',
    });

    expect(await roleHasPermission('admin', PERMISSIONS.USERS_LIST)).toBe(true);
    expect(await roleHasPermission('admin', PERMISSIONS.NOTES_READ_OWN)).toBe(true);

    // Second call is cache-served — only one DDB getRole call total.
    expect(rolesSpies.getRole).toHaveBeenCalledTimes(1);
  });

  it('returns false when the role lacks the permission', async () => {
    rolesSpies.getRole.mockResolvedValue({
      roleName: 'member',
      permissions: new Set<string>([
        PERMISSIONS.NOTES_READ_OWN,
        PERMISSIONS.NOTES_WRITE_OWN,
      ]),
      createdAt: '2025-01-01',
    });

    expect(await roleHasPermission('member', PERMISSIONS.NOTES_READ_OWN)).toBe(true);
    expect(await roleHasPermission('member', PERMISSIONS.USERS_LIST)).toBe(false);
  });

  it('returns false for an unknown role and caches the negative result', async () => {
    rolesSpies.getRole.mockResolvedValue(null);

    expect(await roleHasPermission('ghost', PERMISSIONS.NOTES_READ_OWN)).toBe(false);
    expect(await roleHasPermission('ghost', PERMISSIONS.USERS_LIST)).toBe(false);

    expect(rolesSpies.getRole).toHaveBeenCalledTimes(1);
  });

  it('invalidateRoleCache forces a re-fetch on the next lookup', async () => {
    rolesSpies.getRole.mockResolvedValueOnce({
      roleName: 'member',
      permissions: new Set<string>([PERMISSIONS.NOTES_READ_OWN]),
      createdAt: '2025-01-01',
    });
    expect(await roleHasPermission('member', PERMISSIONS.NOTES_READ_OWN)).toBe(true);

    invalidateRoleCache('member');

    rolesSpies.getRole.mockResolvedValueOnce({
      roleName: 'member',
      permissions: new Set<string>([
        PERMISSIONS.NOTES_READ_OWN,
        PERMISSIONS.NOTES_WRITE_OWN,
      ]),
      createdAt: '2025-01-01',
    });
    expect(await roleHasPermission('member', PERMISSIONS.NOTES_WRITE_OWN)).toBe(true);

    expect(rolesSpies.getRole).toHaveBeenCalledTimes(2);
  });
});
