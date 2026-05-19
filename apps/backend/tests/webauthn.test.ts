import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Required env vars before any module imports (same pattern as auth.test.ts).
process.env.userPoolId = 'pool-id';
process.env.userPoolClientId = 'client-id';
process.env.awsCognitoRegion = 'us-east-1';
process.env.sessionsTableName = 'sessions-table';
process.env.authUsersTableName = 'auth-users-table';
process.env.authRolesTableName = 'auth-roles-table';
process.env.oauthStateTableName = 'oauth-state-table';
process.env.registrationsTableName = 'registrations-table';
process.env.postmarkServerToken = 'fake-postmark-token';
process.env.postmarkFromEmail = 'auth@example.test';
process.env.appUrl = 'http://localhost:4321';

// ----- webauthnStore spies ---------------------------------------------------

const storeSpies = {
  createChallenge: vi.fn(),
  consumeChallenge: vi.fn(),
  registerCredential: vi.fn(),
  getCredential: vi.fn(),
  listCredentialsByUser: vi.fn(),
  updateCredentialCounter: vi.fn(),
  revokeCredential: vi.fn(),
};
vi.mock('../src/auth/webauthnStore.js', () => ({
  createChallenge: (...a: unknown[]) => storeSpies.createChallenge(...a),
  consumeChallenge: (...a: unknown[]) => storeSpies.consumeChallenge(...a),
  registerCredential: (...a: unknown[]) => storeSpies.registerCredential(...a),
  getCredential: (...a: unknown[]) => storeSpies.getCredential(...a),
  listCredentialsByUser: (...a: unknown[]) => storeSpies.listCredentialsByUser(...a),
  updateCredentialCounter: (...a: unknown[]) => storeSpies.updateCredentialCounter(...a),
  revokeCredential: (...a: unknown[]) => storeSpies.revokeCredential(...a),
}));

// ----- @simplewebauthn/server spies ------------------------------------------
// Mock the library so tests don't construct real cryptographic payloads.

const swaSpies = {
  generateRegistrationOptions: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
};
vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: (...a: unknown[]) =>
    swaSpies.generateRegistrationOptions(...a),
  generateAuthenticationOptions: (...a: unknown[]) =>
    swaSpies.generateAuthenticationOptions(...a),
  verifyRegistrationResponse: (...a: unknown[]) =>
    swaSpies.verifyRegistrationResponse(...a),
  verifyAuthenticationResponse: (...a: unknown[]) =>
    swaSpies.verifyAuthenticationResponse(...a),
}));

// ----- sessions / users / cognito spies (mirrors auth.test.ts) --------------

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
  countUsers: vi.fn(),
  createFirstAdmin: vi.fn(),
  linkCognitoSub: vi.fn(),
};
vi.mock('../src/auth/users.js', () => ({
  findUserById: (...a: unknown[]) => usersSpies.findUserById(...a),
  findUserByEmail: (...a: unknown[]) => usersSpies.findUserByEmail(...a),
  countUsers: (...a: unknown[]) => usersSpies.countUsers(...a),
  createFirstAdmin: (...a: unknown[]) => usersSpies.createFirstAdmin(...a),
  linkCognitoSub: (...a: unknown[]) => usersSpies.linkCognitoSub(...a),
}));

vi.mock('../src/email/postmark.js', () => ({ sendOtp: vi.fn() }));

import { app } from '../src/app.js';

function sessionCookie(sessionId: string): string {
  return `hereya_sid=${sessionId}`;
}

function asUser() {
  sessionsSpies.getSession.mockResolvedValue({
    sessionId: 'sid',
    userId: 'u1',
    email: 'alice@example.test',
    roleName: 'admin',
    refreshToken: 'rt',
  });
}

function resetAll() {
  Object.values(storeSpies).forEach((m) => m.mockReset());
  Object.values(swaSpies).forEach((m) => m.mockReset());
  Object.values(sessionsSpies).forEach((m) => m.mockReset());
  Object.values(usersSpies).forEach((m) => m.mockReset());
  cognitoSpies.refreshTokens.mockReset();
  cognitoSpies.refreshTokens.mockResolvedValue({ accessToken: 'at', expiresIn: 3600 });
}

describe('webauthn routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // register/options
  // ---------------------------------------------------------------------------

  it('POST /register/options returns 401 without a session', async () => {
    sessionsSpies.getSession.mockResolvedValue(null);
    const res = await app.request('/api/webauthn/register/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    expect(swaSpies.generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('POST /register/options (authed) persists a register-kind challenge and returns options', async () => {
    asUser();
    storeSpies.listCredentialsByUser.mockResolvedValue([]);
    swaSpies.generateRegistrationOptions.mockResolvedValue({
      challenge: 'CHALLENGE-AAA',
      rp: { id: 'localhost', name: 'hereya-app' },
      user: { id: 'u1', name: 'alice@example.test', displayName: 'alice@example.test' },
      pubKeyCredParams: [],
    });
    storeSpies.createChallenge.mockResolvedValue({ challengeId: 'ch-1' });

    const res = await app.request('/api/webauthn/register/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie('sid') },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { challengeId: string; options: { challenge: string } };
    expect(body.challengeId).toBe('ch-1');
    expect(body.options.challenge).toBe('CHALLENGE-AAA');
    expect(storeSpies.createChallenge).toHaveBeenCalledWith({
      kind: 'register',
      challenge: 'CHALLENGE-AAA',
      userId: 'u1',
      email: 'alice@example.test',
    });
  });

  // ---------------------------------------------------------------------------
  // register/verify
  // ---------------------------------------------------------------------------

  it('POST /register/verify happy path stores the credential and returns ok', async () => {
    asUser();
    storeSpies.consumeChallenge.mockResolvedValue({
      challenge: 'CHALLENGE-AAA',
      kind: 'register',
      userId: 'u1',
      email: 'alice@example.test',
    });
    swaSpies.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'cred-id-1',
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: 0,
          transports: ['internal'],
        },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    });
    storeSpies.registerCredential.mockResolvedValue(undefined);

    const res = await app.request('/api/webauthn/register/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie('sid') },
      body: JSON.stringify({
        challengeId: 'ch-1',
        deviceLabel: 'My MacBook',
        response: { fake: 'response' },
      }),
    });

    expect(res.status).toBe(200);
    expect(storeSpies.registerCredential).toHaveBeenCalledTimes(1);
    const args = storeSpies.registerCredential.mock.calls[0]![0] as {
      credentialId: string;
      userId: string;
      counter: number;
      deviceLabel: string;
      transports: string[];
      publicKey: string;
    };
    expect(args.credentialId).toBe('cred-id-1');
    expect(args.userId).toBe('u1');
    expect(args.counter).toBe(0);
    expect(args.deviceLabel).toBe('My MacBook');
    expect(args.transports).toEqual(['internal']);
    expect(typeof args.publicKey).toBe('string');
  });

  it('POST /register/verify rejects a stale or missing challenge', async () => {
    asUser();
    storeSpies.consumeChallenge.mockResolvedValue(null);

    const res = await app.request('/api/webauthn/register/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie('sid') },
      body: JSON.stringify({
        challengeId: 'ch-stale',
        deviceLabel: 'X',
        response: {},
      }),
    });

    expect(res.status).toBe(400);
    expect(swaSpies.verifyRegistrationResponse).not.toHaveBeenCalled();
    expect(storeSpies.registerCredential).not.toHaveBeenCalled();
  });

  it('POST /register/verify rejects when verifyRegistrationResponse returns verified=false', async () => {
    asUser();
    storeSpies.consumeChallenge.mockResolvedValue({
      challenge: 'CHALLENGE-AAA',
      kind: 'register',
      userId: 'u1',
      email: 'alice@example.test',
    });
    swaSpies.verifyRegistrationResponse.mockResolvedValue({ verified: false });

    const res = await app.request('/api/webauthn/register/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie('sid') },
      body: JSON.stringify({
        challengeId: 'ch-1',
        deviceLabel: 'X',
        response: {},
      }),
    });

    expect(res.status).toBe(401);
    expect(storeSpies.registerCredential).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // authenticate/options
  // ---------------------------------------------------------------------------

  it('POST /authenticate/options without email returns empty allowCredentials (discoverable)', async () => {
    swaSpies.generateAuthenticationOptions.mockResolvedValue({
      challenge: 'AUTH-CHALLENGE-1',
      rpId: 'localhost',
      allowCredentials: [],
    });
    storeSpies.createChallenge.mockResolvedValue({ challengeId: 'ch-auth-1' });

    const res = await app.request('/api/webauthn/authenticate/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { challengeId: string };
    expect(body.challengeId).toBe('ch-auth-1');
    const optsArg = swaSpies.generateAuthenticationOptions.mock.calls[0]![0] as {
      allowCredentials: unknown[];
    };
    expect(optsArg.allowCredentials).toEqual([]);
    expect(usersSpies.findUserByEmail).not.toHaveBeenCalled();
  });

  it('POST /authenticate/options with email returns populated allowCredentials', async () => {
    usersSpies.findUserByEmail.mockResolvedValue({
      id: 'u1',
      email: 'alice@example.test',
      cognitoSub: null,
      roleName: 'admin',
      suspended: false,
      createdAt: new Date().toISOString(),
    });
    storeSpies.listCredentialsByUser.mockResolvedValue([
      { credentialId: 'cred-1', transports: ['internal'] },
      { credentialId: 'cred-2', transports: ['usb'] },
    ]);
    swaSpies.generateAuthenticationOptions.mockResolvedValue({
      challenge: 'AUTH-CHALLENGE-2',
      allowCredentials: [{ id: 'cred-1' }, { id: 'cred-2' }],
    });
    storeSpies.createChallenge.mockResolvedValue({ challengeId: 'ch-auth-2' });

    const res = await app.request('/api/webauthn/authenticate/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.test' }),
    });

    expect(res.status).toBe(200);
    const optsArg = swaSpies.generateAuthenticationOptions.mock.calls[0]![0] as {
      allowCredentials: unknown[];
    };
    expect(optsArg.allowCredentials).toEqual([
      { id: 'cred-1', transports: ['internal'] },
      { id: 'cred-2', transports: ['usb'] },
    ]);
  });

  // ---------------------------------------------------------------------------
  // authenticate/verify
  // ---------------------------------------------------------------------------

  it('POST /authenticate/verify happy path creates a passkey session (refreshToken null)', async () => {
    storeSpies.consumeChallenge.mockResolvedValue({
      challenge: 'AUTH-CHALLENGE-1',
      kind: 'auth',
      userId: null,
      email: null,
    });
    storeSpies.getCredential.mockResolvedValue({
      credentialId: 'cred-1',
      userId: 'u1',
      publicKey: Buffer.from(new Uint8Array([10, 20])).toString('base64url'),
      counter: 5,
      transports: ['internal'],
      deviceLabel: 'MacBook',
      createdAt: '2026-05-01T00:00:00.000Z',
      lastUsedAt: null,
    });
    swaSpies.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 6 },
    });
    usersSpies.findUserById.mockResolvedValue({
      id: 'u1',
      email: 'alice@example.test',
      cognitoSub: null,
      roleName: 'admin',
      suspended: false,
      createdAt: new Date().toISOString(),
    });
    storeSpies.updateCredentialCounter.mockResolvedValue(undefined);
    sessionsSpies.createSession.mockResolvedValue('new-sid');

    const res = await app.request('/api/webauthn/authenticate/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        challengeId: 'ch-auth-1',
        response: { id: 'cred-1', rawId: 'cred-1', response: {}, type: 'public-key' },
      }),
    });

    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/hereya_sid=new-sid/);
    expect(sessionsSpies.createSession).toHaveBeenCalledWith(
      'u1',
      'alice@example.test',
      'admin',
      null, // no Cognito refresh token on passkey sessions
    );
    expect(storeSpies.updateCredentialCounter).toHaveBeenCalledWith('cred-1', 6);
  });

  it('POST /authenticate/verify rejects an unknown credential', async () => {
    storeSpies.consumeChallenge.mockResolvedValue({
      challenge: 'AUTH-CHALLENGE-1',
      kind: 'auth',
      userId: null,
      email: null,
    });
    storeSpies.getCredential.mockResolvedValue(null);

    const res = await app.request('/api/webauthn/authenticate/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        challengeId: 'ch-auth-1',
        response: { id: 'cred-unknown', rawId: 'cred-unknown', response: {}, type: 'public-key' },
      }),
    });

    expect(res.status).toBe(401);
    expect(sessionsSpies.createSession).not.toHaveBeenCalled();
  });

  it('POST /authenticate/verify rejects a counter regression (cloning defense)', async () => {
    storeSpies.consumeChallenge.mockResolvedValue({
      challenge: 'AUTH-CHALLENGE-1',
      kind: 'auth',
      userId: null,
      email: null,
    });
    storeSpies.getCredential.mockResolvedValue({
      credentialId: 'cred-1',
      userId: 'u1',
      publicKey: Buffer.from(new Uint8Array([10])).toString('base64url'),
      counter: 10,
      transports: [],
      deviceLabel: '',
      createdAt: '2026-05-01T00:00:00.000Z',
      lastUsedAt: null,
    });
    swaSpies.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 5 }, // < stored 10
    });

    const res = await app.request('/api/webauthn/authenticate/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        challengeId: 'ch-auth-1',
        response: { id: 'cred-1', rawId: 'cred-1', response: {}, type: 'public-key' },
      }),
    });

    expect(res.status).toBe(401);
    expect(sessionsSpies.createSession).not.toHaveBeenCalled();
    expect(storeSpies.updateCredentialCounter).not.toHaveBeenCalled();
  });

  it('POST /authenticate/verify rejects a suspended user', async () => {
    storeSpies.consumeChallenge.mockResolvedValue({
      challenge: 'AUTH-CHALLENGE-1',
      kind: 'auth',
      userId: null,
      email: null,
    });
    storeSpies.getCredential.mockResolvedValue({
      credentialId: 'cred-1',
      userId: 'u1',
      publicKey: Buffer.from(new Uint8Array([1])).toString('base64url'),
      counter: 1,
      transports: [],
      deviceLabel: '',
      createdAt: '2026-05-01T00:00:00.000Z',
      lastUsedAt: null,
    });
    swaSpies.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 2 },
    });
    usersSpies.findUserById.mockResolvedValue({
      id: 'u1',
      email: 'alice@example.test',
      cognitoSub: null,
      roleName: 'admin',
      suspended: true,
      createdAt: new Date().toISOString(),
    });

    const res = await app.request('/api/webauthn/authenticate/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        challengeId: 'ch-auth-1',
        response: { id: 'cred-1', rawId: 'cred-1', response: {}, type: 'public-key' },
      }),
    });

    expect(res.status).toBe(401);
    expect(sessionsSpies.createSession).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // credentials list + revoke
  // ---------------------------------------------------------------------------

  it('GET /credentials returns the authed user’s registered credentials', async () => {
    asUser();
    storeSpies.listCredentialsByUser.mockResolvedValue([
      {
        credentialId: 'cred-1',
        userId: 'u1',
        publicKey: 'pk',
        counter: 0,
        transports: ['internal'],
        deviceLabel: 'MacBook',
        createdAt: '2026-05-01T00:00:00.000Z',
        lastUsedAt: null,
      },
    ]);

    const res = await app.request('/api/webauthn/credentials', {
      method: 'GET',
      headers: { cookie: sessionCookie('sid') },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      {
        credentialId: 'cred-1',
        deviceLabel: 'MacBook',
        createdAt: '2026-05-01T00:00:00.000Z',
        lastUsedAt: null,
      },
    ]);
  });

  it('DELETE /credentials/:id deletes when owner matches', async () => {
    asUser();
    storeSpies.revokeCredential.mockResolvedValue(true);

    const res = await app.request('/api/webauthn/credentials/cred-1', {
      method: 'DELETE',
      headers: { cookie: sessionCookie('sid') },
    });

    expect(res.status).toBe(200);
    expect(storeSpies.revokeCredential).toHaveBeenCalledWith('cred-1', 'u1');
  });

  it('DELETE /credentials/:id returns 404 when the credential does not belong to the user', async () => {
    asUser();
    storeSpies.revokeCredential.mockResolvedValue(false);

    const res = await app.request('/api/webauthn/credentials/cred-x', {
      method: 'DELETE',
      headers: { cookie: sessionCookie('sid') },
    });

    expect(res.status).toBe(404);
  });
});
