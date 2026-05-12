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
process.env.postmarkServerToken = 'fake';
process.env.postmarkFromEmail = 'auth@example.test';

// Capture every insert via a chainable fake. The newsletter route does:
//   getDb().insert(table).values({...}).onConflictDoNothing()
// dbCall wraps that in a thenable. We mock the chain.
const insertSpy = vi.fn();
const valuesSpy = vi.fn();
const onConflictDoNothingSpy = vi.fn();

valuesSpy.mockImplementation(() => ({
  onConflictDoNothing: onConflictDoNothingSpy.mockResolvedValue(undefined),
}));
insertSpy.mockImplementation(() => ({ values: valuesSpy }));

vi.mock('../src/db/client.js', () => ({
  getDb: () => ({ insert: insertSpy }),
}));
vi.mock('../src/db/schema.js', () => ({
  users: { __name: 'users' },
  notes: { __name: 'notes' },
  newsletterSubscriptions: { __name: 'newsletter_subscriptions' },
}));

vi.mock('../src/auth/cognito.js', () => ({
  ensureUser: vi.fn(),
  startCustomAuth: vi.fn(),
  respondToCustomChallenge: vi.fn(),
  refreshTokens: vi.fn(),
  getCognito: vi.fn(),
}));
vi.mock('../src/auth/sessions.js', () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  deleteSession: vi.fn(),
  deleteUserSessions: vi.fn(),
}));
vi.mock('../src/auth/users.js', () => ({
  findUserByEmail: vi.fn(),
  findUserById: vi.fn(),
  countUsers: vi.fn(),
  createFirstAdmin: vi.fn(),
  addAllowlistedUser: vi.fn(),
  linkCognitoSub: vi.fn(),
  setSuspended: vi.fn(),
  listUsers: vi.fn(),
  countActiveAdmins: vi.fn(),
}));
vi.mock('../src/email/postmark.js', () => ({ sendOtp: vi.fn() }));

// Also skip warmup so isTransient retries don't actually call AWS.
vi.mock('../src/db/resilience.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db/resilience.js')>(
    '../src/db/resilience.js',
  );
  return {
    ...actual,
    warmupCluster: vi.fn().mockResolvedValue(undefined),
  };
});

import { app } from '../src/app.js';

describe('newsletter route', () => {
  beforeEach(() => {
    insertSpy.mockClear();
    valuesSpy.mockClear();
    onConflictDoNothingSpy.mockClear();
    valuesSpy.mockImplementation(() => ({
      onConflictDoNothing: onConflictDoNothingSpy.mockResolvedValue(undefined),
    }));
    insertSpy.mockImplementation(() => ({ values: valuesSpy }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POST /api/newsletter inserts a row', async () => {
    const res = await app.request('/api/newsletter', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'fan@example.test' }),
    });
    expect(res.status).toBe(200);
    expect(valuesSpy).toHaveBeenCalledWith({ email: 'fan@example.test' });
    expect(onConflictDoNothingSpy).toHaveBeenCalled();
  });

  it('POST /api/newsletter is idempotent (same email twice still 200)', async () => {
    await app.request('/api/newsletter', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'fan@example.test' }),
    });
    const res = await app.request('/api/newsletter', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'fan@example.test' }),
    });
    expect(res.status).toBe(200);
    expect(insertSpy).toHaveBeenCalledTimes(2);
    expect(onConflictDoNothingSpy).toHaveBeenCalledTimes(2);
  });

  it('POST /api/newsletter returns 400 on invalid email', async () => {
    const res = await app.request('/api/newsletter', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
