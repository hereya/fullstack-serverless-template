// WebAuthn (passkey) authentication. Lives alongside email/OTP — both
// methods produce identical sessions and downstream behavior.
//
// Two flows:
//
//   REGISTER (authed) — user is already signed in via OTP, adds the
//   current device as a passkey for future logins. Two-step:
//     1. POST /api/webauthn/register/options   → server stores a challenge
//        keyed by a random challengeId, returns options for navigator.
//        credentials.create()
//     2. POST /api/webauthn/register/verify    → server consumes challenge,
//        verifies attestation, persists credential
//
//   AUTHENTICATE (anonymous) — user signs in without OTP. Two-step:
//     1. POST /api/webauthn/authenticate/options  → server stores challenge,
//        returns options for navigator.credentials.get(). allowCredentials
//        is empty by default (discoverable / "one-click" sign-in) but
//        populated when the client provides an email hint.
//     2. POST /api/webauthn/authenticate/verify   → server consumes
//        challenge, verifies assertion, mints a session cookie identical
//        to /verify-otp's.
//
// Storage lives in DDB on the shared aws-ddb-app-state table, via
// webauthnStore.ts (WACRED# / WACHAL# discriminators).

import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { z } from 'zod';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  createChallenge,
  consumeChallenge,
  getCredential,
  listCredentialsByUser,
  registerCredential,
  revokeCredential,
  updateCredentialCounter,
} from '../auth/webauthnStore.js';
import { createSession } from '../auth/sessions.js';
import { findUserByEmail, findUserById } from '../auth/users.js';
import { authMiddleware } from '../middleware/auth.js';

export const webauthn = new Hono();

// Friendly name shown to the user in the OS passkey prompt. Each project
// scaffolded from this template should rename this to match their app's
// product name.
const RP_NAME = 'hereya-app';

// Same constant-time defense as /request-otp + /verify-otp: every
// response on the unauthenticated authenticate/* endpoints pays at least
// this much wall-clock time so timing can't enumerate "is this email
// registered?". Test env runs at 0 to keep the suite fast.
const RESPONSE_MIN_MS = process.env.NODE_ENV === 'test' ? 0 : 800;

function pad(start: number, minMs: number): Promise<void> {
  const elapsed = Date.now() - start;
  if (elapsed >= minMs) return Promise.resolve();
  return new Promise((r) => setTimeout(r, minMs - elapsed));
}

const isProd = () => process.env.NODE_ENV === 'production';

function cookieOpts() {
  return {
    httpOnly: true,
    secure: isProd(),
    sameSite: 'Lax' as const,
    path: '/',
  };
}

// rpID = the eTLD+1 (hostname only) the relying party serves under.
// Passkeys are bound to this value at registration; a future domain
// change invalidates existing credentials. Order of precedence:
//   1. process.env.appUrl (set in prod by hereya/aws-app-lambda)
//   2. the request's Origin header (covers local dev)
//   3. the request URL itself (last-ditch fallback)
function rpConfig(reqUrl: URL, originHeader: string | null): {
  rpID: string;
  origin: string;
} {
  const fromEnv = process.env.appUrl;
  if (fromEnv) {
    try {
      const u = new URL(fromEnv);
      return { rpID: u.hostname, origin: u.origin };
    } catch {
      // fall through to header / req
    }
  }
  if (originHeader) {
    try {
      const u = new URL(originHeader);
      return { rpID: u.hostname, origin: u.origin };
    } catch {
      // fall through
    }
  }
  return { rpID: reqUrl.hostname, origin: reqUrl.origin };
}

// ============================================================================
// REGISTER — auth required
// ============================================================================

webauthn.post('/register/options', authMiddleware, async (c) => {
  const user = c.get('user');
  const { rpID } = rpConfig(new URL(c.req.url), c.req.header('origin') ?? null);

  // Exclude already-registered credentials so the OS prompts to add a
  // different one (rather than silently overwriting the same passkey).
  const existing = await listCredentialsByUser(user.id);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userID: new TextEncoder().encode(user.id),
    userName: user.email,
    userDisplayName: user.email,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    excludeCredentials: existing.map((cred) => ({
      id: cred.credentialId,
      transports: cred.transports as AuthenticatorTransportFuture[],
    })),
  });

  const { challengeId } = await createChallenge({
    kind: 'register',
    challenge: options.challenge,
    userId: user.id,
    email: user.email,
  });

  return c.json({ challengeId, options });
});

const registerVerifySchema = z.object({
  challengeId: z.string().min(1),
  deviceLabel: z.string().min(1).max(80),
  response: z.unknown(),
});

webauthn.post('/register/verify', authMiddleware, async (c) => {
  const user = c.get('user');
  const parsed = registerVerifySchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: 'invalid body' }, 400);
  }
  const { challengeId, deviceLabel, response } = parsed.data;

  const challengeRow = await consumeChallenge(challengeId, 'register');
  if (!challengeRow || challengeRow.userId !== user.id) {
    return c.json({ error: 'invalid challenge' }, 400);
  }

  const { rpID, origin } = rpConfig(
    new URL(c.req.url),
    c.req.header('origin') ?? null,
  );

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[webauthn] register verify failed:', err);
    return c.json({ error: 'verification failed' }, 401);
  }

  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: 'verification failed' }, 401);
  }

  const { credential } = verification.registrationInfo;
  await registerCredential({
    credentialId: credential.id,
    userId: user.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: (credential.transports as string[] | undefined) ?? [],
    deviceLabel,
  });

  return c.json({ ok: true, credentialId: credential.id });
});

// ============================================================================
// AUTHENTICATE — no auth (this IS the auth)
// ============================================================================

const authOptionsSchema = z.object({
  email: z.string().email().optional(),
});

webauthn.post('/authenticate/options', async (c) => {
  const t0 = Date.now();
  const parsed = authOptionsSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    await pad(t0, RESPONSE_MIN_MS);
    return c.json({ error: 'invalid body' }, 400);
  }
  const { email } = parsed.data;
  const { rpID } = rpConfig(new URL(c.req.url), c.req.header('origin') ?? null);

  // Default flow: empty allowCredentials → discoverable / one-click sign-in,
  // OS picks the passkey, returns userHandle = our userId. With an email
  // hint we narrow the list (still constant-time on the response).
  let allowCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] = [];
  if (email) {
    const user = await findUserByEmail(email);
    if (user && !user.suspended) {
      const creds = await listCredentialsByUser(user.id);
      allowCredentials = creds.map((cred) => ({
        id: cred.credentialId,
        transports: cred.transports as AuthenticatorTransportFuture[],
      }));
    }
    // Unknown / suspended email: still return a valid options object so
    // the response is indistinguishable.
  }

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials,
    userVerification: 'preferred',
  });

  const { challengeId } = await createChallenge({
    kind: 'auth',
    challenge: options.challenge,
    userId: null,
    email: email ?? null,
  });

  await pad(t0, RESPONSE_MIN_MS);
  return c.json({ challengeId, options });
});

const authVerifySchema = z.object({
  challengeId: z.string().min(1),
  response: z.unknown(),
});

webauthn.post('/authenticate/verify', async (c) => {
  const t0 = Date.now();
  const parsed = authVerifySchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    await pad(t0, RESPONSE_MIN_MS);
    return c.json({ error: 'invalid body' }, 400);
  }
  const { challengeId, response } = parsed.data;
  const assertion = response as AuthenticationResponseJSON;

  const challengeRow = await consumeChallenge(challengeId, 'auth');
  if (!challengeRow) {
    await pad(t0, RESPONSE_MIN_MS);
    return c.json({ error: 'invalid challenge' }, 401);
  }

  const credential = await getCredential(assertion.id);
  if (!credential) {
    await pad(t0, RESPONSE_MIN_MS);
    return c.json({ error: 'unknown credential' }, 401);
  }

  const { rpID, origin } = rpConfig(
    new URL(c.req.url),
    c.req.header('origin') ?? null,
  );

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: credential.credentialId,
        publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')),
        counter: credential.counter,
        transports: credential.transports as AuthenticatorTransportFuture[],
      },
      requireUserVerification: false,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[webauthn] authenticate verify failed:', err);
    await pad(t0, RESPONSE_MIN_MS);
    return c.json({ error: 'verification failed' }, 401);
  }

  if (!verification.verified) {
    await pad(t0, RESPONSE_MIN_MS);
    return c.json({ error: 'verification failed' }, 401);
  }

  // Cloning defense: signature counter must be monotonic. A non-zero
  // newCounter that doesn't advance past the stored value strongly
  // suggests a cloned authenticator; refuse the sign-in.
  const { newCounter } = verification.authenticationInfo;
  if (newCounter !== 0 && newCounter <= credential.counter) {
    // eslint-disable-next-line no-console
    console.warn(
      '[webauthn] counter regression — possible clone:',
      credential.credentialId,
    );
    await pad(t0, RESPONSE_MIN_MS);
    return c.json({ error: 'verification failed' }, 401);
  }

  const user = await findUserById(credential.userId);
  if (!user || user.suspended) {
    await pad(t0, RESPONSE_MIN_MS);
    return c.json({ error: 'verification failed' }, 401);
  }

  await updateCredentialCounter(credential.credentialId, newCounter);

  // null refreshToken: passkey-initiated sessions don't go through
  // Cognito at all, so there's nothing to refresh. authMiddleware
  // detects null and skips the refresh path.
  const sessionId = await createSession(
    user.id,
    user.email,
    user.roleName,
    null,
  );

  setCookie(c, 'hereya_sid', sessionId, {
    ...cookieOpts(),
    maxAge: 30 * 24 * 3600,
  });

  await pad(t0, RESPONSE_MIN_MS);
  return c.json({ ok: true });
});

// ============================================================================
// CREDENTIALS — listing + revoking (authed)
// ============================================================================

webauthn.get('/credentials', authMiddleware, async (c) => {
  const user = c.get('user');
  const creds = await listCredentialsByUser(user.id);
  return c.json(
    creds.map((cred) => ({
      credentialId: cred.credentialId,
      deviceLabel: cred.deviceLabel,
      createdAt: cred.createdAt,
      lastUsedAt: cred.lastUsedAt,
    })),
  );
});

webauthn.delete('/credentials/:credentialId', authMiddleware, async (c) => {
  const user = c.get('user');
  const credentialId = c.req.param('credentialId');
  if (!credentialId) {
    return c.json({ error: 'not found' }, 404);
  }
  const ok = await revokeCredential(credentialId, user.id);
  if (!ok) {
    return c.json({ error: 'not found' }, 404);
  }
  return c.json({ ok: true });
});
