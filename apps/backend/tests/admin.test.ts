import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.userPoolId = 'pool-id';
process.env.userPoolClientId = 'client-id';
process.env.awsCognitoRegion = 'us-east-1';
process.env.sessionsTableName = 'sessions-table';
process.env.authUsersTableName = 'auth-users-table';
process.env.authRolesTableName = 'auth-roles-table';
process.env.clusterArn = 'arn:aws:rds::cluster';
process.env.secretArn = 'arn:aws:secret::s';
process.env.databaseName = 'appdb';
process.env.postmarkServerToken = 'fake-postmark-token';
process.env.postmarkFromEmail = 'auth@example.test';

const sessionsSpies = {
  getSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  deleteUserSessions: vi.fn(),
};
vi.mock('../src/auth/sessions.js', () => ({
  getSession: (...a: unknown[]) => sessionsSpies.getSession(...a),
  createSession: (...a: unknown[]) => sessionsSpies.createSession(...a),
  deleteSession: (...a: unknown[]) => sessionsSpies.deleteSession(...a),
  deleteUserSessions: (...a: unknown[]) => sessionsSpies.deleteUserSessions(...a),
}));

const cognitoSpies = {
  refreshTokens: vi.fn().mockResolvedValue({ accessToken: 'at', expiresIn: 3600 }),
};
vi.mock('../src/auth/cognito.js', () => ({
  ensureUser: vi.fn(),
  startCustomAuth: vi.fn(),
  respondToCustomChallenge: vi.fn(),
  refreshTokens: (...a: unknown[]) => cognitoSpies.refreshTokens(...a),
  getCognito: vi.fn(),
}));

const usersSpies = {
  findUserById: vi.fn(),
  findUserByEmail: vi.fn(),
  addAllowlistedUser: vi.fn(),
  listUsers: vi.fn(),
  setSuspended: vi.fn(),
  countActiveAdmins: vi.fn(),
  countUsers: vi.fn(),
  createFirstAdmin: vi.fn(),
  linkCognitoSub: vi.fn(),
};
vi.mock('../src/auth/users.js', () => ({
  findUserById: (...a: unknown[]) => usersSpies.findUserById(...a),
  findUserByEmail: (...a: unknown[]) => usersSpies.findUserByEmail(...a),
  addAllowlistedUser: (...a: unknown[]) => usersSpies.addAllowlistedUser(...a),
  listUsers: (...a: unknown[]) => usersSpies.listUsers(...a),
  setSuspended: (...a: unknown[]) => usersSpies.setSuspended(...a),
  countActiveAdmins: (...a: unknown[]) => usersSpies.countActiveAdmins(...a),
  countUsers: (...a: unknown[]) => usersSpies.countUsers(...a),
  createFirstAdmin: (...a: unknown[]) => usersSpies.createFirstAdmin(...a),
  linkCognitoSub: (...a: unknown[]) => usersSpies.linkCognitoSub(...a),
}));

vi.mock('../src/email/postmark.js', () => ({ sendOtp: vi.fn() }));

// Mock the permissions module's runtime: admin role grants everything,
// member grants nothing useful for /api/admin/*. Avoids needing a real
// authRolesTable read in unit tests.
vi.mock('../src/auth/permissions.js', async () => {
  const ADMIN_ALLOW = new Set([
    'users:list',
    'users:add',
    'users:suspend',
  ]);
  return {
    PERMISSIONS: {
      USERS_LIST: 'users:list',
      USERS_ADD: 'users:add',
      USERS_SUSPEND: 'users:suspend',
    },
    ALL_PERMISSIONS: [...ADMIN_ALLOW],
    roleHasPermission: async (roleName: string, perm: string) => {
      if (roleName === 'admin') return ADMIN_ALLOW.has(perm);
      return false;
    },
    invalidateRoleCache: () => undefined,
  };
});

import { app } from '../src/app.js';

function sessionCookie(sessionId: string): string {
  return `hereya_sid=${sessionId}`;
}

function adminUserRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'u-admin',
    email: 'admin@example.test',
    cognitoSub: 'sub-admin',
    roleName: 'admin',
    suspended: false,
    createdAt: new Date(),
    ...overrides,
  };
}

function memberUserRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'u-member',
    email: 'member@example.test',
    cognitoSub: 'sub-member',
    roleName: 'member',
    suspended: false,
    createdAt: new Date(),
    ...overrides,
  };
}

// Wire up an authenticated admin session for downstream calls.
// Note: role is on the session row now — authMiddleware reads it directly,
// no findUserById in the hot path.
function asAdmin() {
  sessionsSpies.getSession.mockResolvedValue({
    sessionId: 'sid',
    userId: 'u-admin',
    email: 'admin@example.test',
    roleName: 'admin',
    refreshToken: 'rt',
  });
}

function asMember() {
  sessionsSpies.getSession.mockResolvedValue({
    sessionId: 'sid',
    userId: 'u-member',
    email: 'member@example.test',
    roleName: 'member',
    refreshToken: 'rt',
  });
}

describe('admin routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.values(sessionsSpies).forEach((m) => m.mockReset());
    Object.values(usersSpies).forEach((m) => m.mockReset());
    cognitoSpies.refreshTokens.mockReset();
    cognitoSpies.refreshTokens.mockResolvedValue({ accessToken: 'at', expiresIn: 3600 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /api/admin/users requires auth (401 without cookie)', async () => {
    const res = await app.request('/api/admin/users');
    expect(res.status).toBe(401);
  });

  it('GET /api/admin/users returns 403 for a member', async () => {
    asMember();
    const res = await app.request('/api/admin/users', {
      headers: { cookie: sessionCookie('sid') },
    });
    expect(res.status).toBe(403);
  });

  it('GET /api/admin/users returns the list for an admin', async () => {
    asAdmin();
    usersSpies.listUsers.mockResolvedValue([
      adminUserRow(),
      memberUserRow({ cognitoSub: null }),
    ]);

    const res = await app.request('/api/admin/users', {
      headers: { cookie: sessionCookie('sid') },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    expect(body[0]?.roleName).toBe('admin');
    expect(body[0]?.hasSignedIn).toBe(true);
    expect(body[1]?.hasSignedIn).toBe(false);
  });

  it('POST /api/admin/users adds a member with no cognito_sub', async () => {
    asAdmin();
    usersSpies.addAllowlistedUser.mockResolvedValue({
      id: 'u-new', email: 'new@example.test', cognitoSub: null,
      roleName: 'member', suspended: false, createdAt: new Date(),
    });

    const res = await app.request('/api/admin/users', {
      method: 'POST',
      headers: { cookie: sessionCookie('sid'), 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.test' }),
    });
    expect(res.status).toBe(201);
    expect(usersSpies.addAllowlistedUser).toHaveBeenCalledWith('new@example.test');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.roleName).toBe('member');
    expect(body.hasSignedIn).toBe(false);
  });

  it('POST /api/admin/users returns 409 on duplicate email', async () => {
    asAdmin();
    const dupe = new Error('User with email dupe@example.test already exists');
    (dupe as { name?: string }).name = 'UserAlreadyExistsException';
    usersSpies.addAllowlistedUser.mockRejectedValue(dupe);

    const res = await app.request('/api/admin/users', {
      method: 'POST',
      headers: { cookie: sessionCookie('sid'), 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dupe@example.test' }),
    });
    expect(res.status).toBe(409);
  });

  it('PATCH /api/admin/users/:id toggles suspended AND invalidates target sessions', async () => {
    asAdmin();
    usersSpies.findUserById.mockImplementation(async (id) => {
      if (id === 'u-admin') return adminUserRow();
      if (id === 'u-target') return memberUserRow({ id: 'u-target' });
      return null;
    });
    usersSpies.setSuspended.mockResolvedValue(
      memberUserRow({ id: 'u-target', suspended: true }),
    );
    sessionsSpies.deleteUserSessions.mockResolvedValue(undefined);

    const res = await app.request('/api/admin/users/u-target', {
      method: 'PATCH',
      headers: { cookie: sessionCookie('sid'), 'content-type': 'application/json' },
      body: JSON.stringify({ suspended: true }),
    });
    expect(res.status).toBe(200);
    expect(usersSpies.setSuspended).toHaveBeenCalledWith('u-target', true);
    // Hot-path authz invariant: suspending a user must tear down their
    // active sessions, because authMiddleware no longer re-checks Aurora
    // on every request.
    expect(sessionsSpies.deleteUserSessions).toHaveBeenCalledWith('u-target');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.suspended).toBe(true);
  });

  it('PATCH /api/admin/users/:id with suspended=false does NOT delete sessions', async () => {
    asAdmin();
    usersSpies.findUserById.mockImplementation(async (id) => {
      if (id === 'u-admin') return adminUserRow();
      if (id === 'u-target') {
        return memberUserRow({ id: 'u-target', suspended: true });
      }
      return null;
    });
    usersSpies.setSuspended.mockResolvedValue(
      memberUserRow({ id: 'u-target', suspended: false }),
    );

    const res = await app.request('/api/admin/users/u-target', {
      method: 'PATCH',
      headers: { cookie: sessionCookie('sid'), 'content-type': 'application/json' },
      body: JSON.stringify({ suspended: false }),
    });
    expect(res.status).toBe(200);
    expect(sessionsSpies.deleteUserSessions).not.toHaveBeenCalled();
  });

  it('PATCH /api/admin/users/:id refuses to suspend the last active admin', async () => {
    asAdmin();
    usersSpies.findUserById.mockImplementation(async (id) => {
      if (id === 'u-admin') return adminUserRow();
      return null;
    });
    usersSpies.countActiveAdmins.mockResolvedValue(0); // no other admins

    const res = await app.request('/api/admin/users/u-admin', {
      method: 'PATCH',
      headers: { cookie: sessionCookie('sid'), 'content-type': 'application/json' },
      body: JSON.stringify({ suspended: true }),
    });
    expect(res.status).toBe(400);
    expect(usersSpies.setSuspended).not.toHaveBeenCalled();
  });

  it('PATCH /api/admin/users/:id returns 404 for unknown user', async () => {
    asAdmin();
    usersSpies.findUserById.mockImplementation(async (id) => {
      if (id === 'u-admin') return adminUserRow();
      return null;
    });

    const res = await app.request('/api/admin/users/u-ghost', {
      method: 'PATCH',
      headers: { cookie: sessionCookie('sid'), 'content-type': 'application/json' },
      body: JSON.stringify({ suspended: true }),
    });
    expect(res.status).toBe(404);
  });
});
