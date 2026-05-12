import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Set required env vars BEFORE any module imports
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

// Spies the cognito + sessions modules expose
const cognitoSpies = {
  ensureUser: vi.fn(),
  startCustomAuth: vi.fn(),
  respondToCustomChallenge: vi.fn(),
};

vi.mock('../src/auth/cognito.js', async () => {
  return {
    ensureUser: (...args: unknown[]) => cognitoSpies.ensureUser(...args),
    startCustomAuth: (...args: unknown[]) => cognitoSpies.startCustomAuth(...args),
    respondToCustomChallenge: (...args: unknown[]) =>
      cognitoSpies.respondToCustomChallenge(...args),
    refreshTokens: vi.fn(),
    getCognito: vi.fn(),
    _setCognito: vi.fn(),
  };
});

const sessionsSpies = {
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getSession: vi.fn(),
};

vi.mock('../src/auth/sessions.js', () => ({
  createSession: (...args: unknown[]) => sessionsSpies.createSession(...args),
  deleteSession: (...args: unknown[]) => sessionsSpies.deleteSession(...args),
  getSession: (...args: unknown[]) => sessionsSpies.getSession(...args),
  deleteUserSessions: vi.fn(),
}));

const usersSpies = {
  findUserByEmail: vi.fn(),
  findUserById: vi.fn(),
  bootstrapComplete: vi.fn(),
  countUsers: vi.fn(),
  createFirstAdmin: vi.fn(),
  addAllowlistedUser: vi.fn(),
  linkCognitoSub: vi.fn(),
  setSuspended: vi.fn(),
  listUsers: vi.fn(),
  countActiveAdmins: vi.fn(),
};
vi.mock('../src/auth/users.js', () => ({
  findUserByEmail: (...a: unknown[]) => usersSpies.findUserByEmail(...a),
  findUserById: (...a: unknown[]) => usersSpies.findUserById(...a),
  bootstrapComplete: (...a: unknown[]) => usersSpies.bootstrapComplete(...a),
  countUsers: (...a: unknown[]) => usersSpies.countUsers(...a),
  createFirstAdmin: (...a: unknown[]) => usersSpies.createFirstAdmin(...a),
  addAllowlistedUser: (...a: unknown[]) => usersSpies.addAllowlistedUser(...a),
  linkCognitoSub: (...a: unknown[]) => usersSpies.linkCognitoSub(...a),
  setSuspended: (...a: unknown[]) => usersSpies.setSuspended(...a),
  listUsers: (...a: unknown[]) => usersSpies.listUsers(...a),
  countActiveAdmins: (...a: unknown[]) => usersSpies.countActiveAdmins(...a),
}));

const postmarkSpies = {
  sendOtp: vi.fn().mockResolvedValue(undefined),
};
vi.mock('../src/email/postmark.js', () => ({
  sendOtp: (...args: unknown[]) => postmarkSpies.sendOtp(...args),
}));

// Mock the db modules so importing the app doesn't try to talk to RDS.
vi.mock('../src/db/client.js', () => ({
  getDb: () => {
    throw new Error('db not available in unit tests');
  },
}));

vi.mock('../src/db/schema.js', () => ({
  users: {},
  notes: {},
  newsletterSubscriptions: {},
}));

import { app } from '../src/app.js';

// Build a JWT-shaped string with the given payload (header + payload + sig).
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return [b64({ alg: 'none', typ: 'JWT' }), b64(payload), 'sig'].join('.');
}

function resetAllSpies() {
  Object.values(cognitoSpies).forEach((m) => m.mockReset());
  Object.values(sessionsSpies).forEach((m) => m.mockReset());
  Object.values(usersSpies).forEach((m) => m.mockReset());
  postmarkSpies.sendOtp.mockReset();
  postmarkSpies.sendOtp.mockResolvedValue(undefined);
}

describe('auth routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetAllSpies();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POST /api/auth/request-otp returns only the session — never the OTP (first-user path)', async () => {
    const SECRET_OTP = '999111';
    usersSpies.findUserByEmail.mockResolvedValue(null);
    usersSpies.countUsers.mockResolvedValue(0); // empty table → first-user bootstrap
    cognitoSpies.ensureUser.mockResolvedValue(undefined);
    cognitoSpies.startCustomAuth.mockResolvedValue({
      session: 'cognito-session-token',
      otp: SECRET_OTP,
    });

    const res = await app.request('/api/auth/request-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.test' }),
    });

    expect(res.status).toBe(200);
    const rawText = await res.text();

    // Critical: response body must NOT contain the OTP value anywhere.
    expect(rawText).not.toContain(SECRET_OTP);

    // It MUST contain the session.
    const body = JSON.parse(rawText);
    expect(body).toEqual({ session: 'cognito-session-token' });

    expect(cognitoSpies.ensureUser).toHaveBeenCalledWith('alice@example.test');
    expect(cognitoSpies.startCustomAuth).toHaveBeenCalledWith('alice@example.test');
    expect(postmarkSpies.sendOtp).toHaveBeenCalledWith('alice@example.test', SECRET_OTP);
  });

  it('POST /api/auth/request-otp returns a fake session for an unknown email (enumeration defense)', async () => {
    // The endpoint MUST NOT signal whether the email is in the allowlist.
    // Disallowed callers get a session token shaped like a real one, no
    // Cognito call, no email send. verify-otp later refuses with the
    // same 'invalid code' a wrong OTP would produce.
    usersSpies.findUserByEmail.mockResolvedValue(null);
    usersSpies.countUsers.mockResolvedValue(1); // someone exists → closed signup

    const res = await app.request('/api/auth/request-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'random@example.test' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { session?: string };
    expect(typeof body.session).toBe('string');
    expect(body.session!.length).toBeGreaterThan(0);
    expect(cognitoSpies.ensureUser).not.toHaveBeenCalled();
    expect(cognitoSpies.startCustomAuth).not.toHaveBeenCalled();
    expect(postmarkSpies.sendOtp).not.toHaveBeenCalled();
  });

  it('POST /api/auth/request-otp routes likely-bot honeypot hits down the fake path (no Cognito, no email, no allowlist lookup)', async () => {
    // Mock would return a valid first-user path if the lookup ran, so a
    // bot-honeypot bypass would be visible: ensureUser/sendOtp called.
    usersSpies.findUserByEmail.mockResolvedValue(null);
    usersSpies.countUsers.mockResolvedValue(0);

    const res = await app.request('/api/auth/request-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'bot@example.test',
        website: 'http://spammer.test', // honeypot — humans never fill this
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { session?: string };
    expect(typeof body.session).toBe('string');
    expect(body.session!.length).toBeGreaterThan(0);
    // Critical: the bot signal short-circuits BEFORE any backend lookup.
    expect(usersSpies.findUserByEmail).not.toHaveBeenCalled();
    expect(usersSpies.countUsers).not.toHaveBeenCalled();
    expect(cognitoSpies.ensureUser).not.toHaveBeenCalled();
    expect(cognitoSpies.startCustomAuth).not.toHaveBeenCalled();
    expect(postmarkSpies.sendOtp).not.toHaveBeenCalled();
  });

  it('POST /api/auth/request-otp returns a fake session for a suspended user (enumeration defense)', async () => {
    usersSpies.findUserByEmail.mockResolvedValue({
      id: 'u1', email: 'bob@example.test', cognitoSub: 'sub-1',
      roleName: 'member', suspended: true, createdAt: new Date(),
    });

    const res = await app.request('/api/auth/request-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.test' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { session?: string };
    expect(typeof body.session).toBe('string');
    expect(body.session!.length).toBeGreaterThan(0);
    expect(cognitoSpies.ensureUser).not.toHaveBeenCalled();
    expect(cognitoSpies.startCustomAuth).not.toHaveBeenCalled();
    expect(postmarkSpies.sendOtp).not.toHaveBeenCalled();
  });

  it('POST /api/auth/request-otp allows allowlisted (not-yet-signed-in) user', async () => {
    usersSpies.findUserByEmail.mockResolvedValue({
      id: 'u2', email: 'carol@example.test', cognitoSub: null,
      roleName: 'member', suspended: false, createdAt: new Date(),
    });
    cognitoSpies.ensureUser.mockResolvedValue(undefined);
    cognitoSpies.startCustomAuth.mockResolvedValue({
      session: 'sess-x', otp: '424242',
    });

    const res = await app.request('/api/auth/request-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'carol@example.test' }),
    });

    expect(res.status).toBe(200);
    expect(cognitoSpies.startCustomAuth).toHaveBeenCalled();
  });

  it('POST /api/auth/verify-otp first-user path creates admin and sets cookie', async () => {
    const idToken = fakeJwt({ sub: 'sub-alice', email: 'alice@example.test' });
    cognitoSpies.respondToCustomChallenge.mockResolvedValue({
      AuthenticationResult: {
        AccessToken: 'at', IdToken: idToken, RefreshToken: 'rt', ExpiresIn: 3600,
      },
    });
    usersSpies.findUserByEmail.mockResolvedValue(null);
    usersSpies.countUsers.mockResolvedValue(0);
    usersSpies.createFirstAdmin.mockResolvedValue({
      id: 'u-alice', email: 'alice@example.test', cognitoSub: 'sub-alice',
      roleName: 'admin', suspended: false, createdAt: new Date(),
    });
    sessionsSpies.createSession.mockResolvedValue('session-id-123');

    const res = await app.request('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.test', session: 'sess', code: '123456',
      }),
    });

    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/hereya_sid=session-id-123/);
    expect(usersSpies.createFirstAdmin).toHaveBeenCalledWith(
      'alice@example.test',
      'sub-alice',
    );
    expect(sessionsSpies.createSession).toHaveBeenCalledWith(
      'u-alice',           // LOCAL id, not the Cognito sub
      'alice@example.test',
      'admin',             // role snapshotted onto the session row
      'rt',
    );
  });

  it('POST /api/auth/verify-otp links cognito_sub on first sign-in of an allowlisted user', async () => {
    const idToken = fakeJwt({ sub: 'sub-carol', email: 'carol@example.test' });
    cognitoSpies.respondToCustomChallenge.mockResolvedValue({
      AuthenticationResult: {
        AccessToken: 'at', IdToken: idToken, RefreshToken: 'rt', ExpiresIn: 3600,
      },
    });
    usersSpies.findUserByEmail.mockResolvedValue({
      id: 'u-carol', email: 'carol@example.test', cognitoSub: null,
      roleName: 'member', suspended: false, createdAt: new Date(),
    });
    sessionsSpies.createSession.mockResolvedValue('sess-id');

    const res = await app.request('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'carol@example.test', session: 'sess', code: '424242',
      }),
    });

    expect(res.status).toBe(200);
    expect(usersSpies.linkCognitoSub).toHaveBeenCalledWith('u-carol', 'sub-carol');
    expect(sessionsSpies.createSession).toHaveBeenCalledWith(
      'u-carol', 'carol@example.test', 'member', 'rt',
    );
  });

  it('POST /api/auth/verify-otp returns 401 on Cognito failure', async () => {
    cognitoSpies.respondToCustomChallenge.mockRejectedValue(
      new Error('NotAuthorizedException'),
    );

    const res = await app.request('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.test', session: 'sess', code: '000000',
      }),
    });

    expect(res.status).toBe(401);
  });

  it('GET /api/auth/me without cookie returns 401', async () => {
    const res = await app.request('/api/auth/me', { method: 'GET' });
    expect(res.status).toBe(401);
  });
});
