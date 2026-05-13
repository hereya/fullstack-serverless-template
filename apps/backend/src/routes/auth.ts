import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { jwtDecode } from 'jwt-decode';
import { z } from 'zod';
import {
  ensureUser,
  startCustomAuth,
  respondToCustomChallenge,
} from '../auth/cognito.js';
import {
  createSession,
  deleteSession,
} from '../auth/sessions.js';
import {
  countUsers,
  createFirstAdmin,
  findUserByEmail,
  linkCognitoSub,
} from '../auth/users.js';
import { sendOtp } from '../email/postmark.js';
import { authMiddleware } from '../middleware/auth.js';

export const auth = new Hono();

// `website` is a honeypot — see request-otp handler for the rationale.
// Schema permits any string; non-empty is a bot signal.
const requestOtpSchema = z.object({
  email: z.string().email(),
  website: z.string().optional(),
});
const verifyOtpSchema = z.object({
  email: z.string().email(),
  session: z.string().min(1),
  code: z.string().min(1),
});

const isProd = () => process.env.NODE_ENV === 'production';

function cookieOpts() {
  return {
    httpOnly: true,
    secure: isProd(),
    sameSite: 'Lax' as const,
    path: '/',
  };
}

// Closed signup with first-user bootstrap, hardened against email
// enumeration via BOTH the HTTP-status signal AND the response-timing
// side channel.
//
// Decision tree (server-side):
//
//   • Empty `users` table  →  allow signup; first email becomes admin
//     once verify-otp succeeds.
//   • Non-empty table, email IS in allowlist, not suspended  →  proceed.
//   • Anything else (not in allowlist, suspended)  →  return an opaque
//     fake session, send NO email.
//
// Two defenses, applied to ALL branches:
//
//   1. Identical response shape + status (200 + `{ session: string }`).
//      A 403 / different payload would let an attacker enumerate
//      allowed emails just by probing this endpoint. Disallowed callers
//      receive an unredeemable token; verify-otp later reports
//      `invalid code` regardless of what they submit.
//
//   2. Identical response timing. A constant-time pad ensures every
//      response (legit or fake) takes at least RESPONSE_MIN_MS.
//
// IMPORTANT — Lambda fire-and-forget gotcha:
//
// We can't write `void sendOtp(...).catch(...)` here and rely on the
// event loop to finish the email send after the handler returns. The
// Lambda runtime FREEZES the execution context the moment the handler's
// promise resolves; any pending background work gets frozen mid-flight
// and on a cold-started or recycled container that work is discarded.
// Symptom: works perfectly in local dev (Node keeps the event loop
// alive), emails silently drop in production — most visible on
// "Resend code" because users notice the second email never arrives.
//
// Instead we run sendOtp IN PARALLEL with the timing pad via
// Promise.all. Both block the handler from returning, but they execute
// concurrently — total response time is max(sendOtp, pad), not sum.
// The Lambda only freezes after sendOtp is genuinely complete.
//
// RESPONSE_MIN_MS is 0 in tests to keep the suite fast; production
// gets the real pad. Tune slightly above your p99 sendOtp latency if
// you want sendOtp to almost always finish within the pad window
// (and so add zero extra time vs the disallowed path).
const RESPONSE_MIN_MS = process.env.NODE_ENV === 'test' ? 0 : 800;

function pad(start: number, minMs: number): Promise<void> {
  const elapsed = Date.now() - start;
  if (elapsed >= minMs) return Promise.resolve();
  return new Promise((r) => setTimeout(r, minMs - elapsed));
}

auth.post('/request-otp', async (c) => {
  const t0 = Date.now();
  const parsed = requestOtpSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const { email, website } = parsed.data;

  // Honeypot. The frontend renders a hidden `website` field that's
  // off-screen and aria-hidden, so legitimate humans never fill it.
  // Naive bots scrape every form input and submit non-empty values —
  // we use that as a free bot signal. NO secret keys required, no
  // third-party CAPTCHA, no UX cost for real users.
  //
  // Caught requests go through the existing "disallowed" path: opaque
  // fake session, no Cognito call, no email, same constant-time
  // response. The bot can't tell it was filtered.
  const isLikelyBot = typeof website === 'string' && website.length > 0;

  const user = isLikelyBot ? null : await findUserByEmail(email);
  let allowed = false;
  if (isLikelyBot) {
    // Skip every backend lookup; stay on the fake path.
    allowed = false;
  } else if (!user) {
    const total = await countUsers();
    if (total === 0) {
      // First-user bootstrap — anyone may sign up. Whoever lands here
      // becomes admin in verify-otp.
      allowed = true;
    }
    // else: email not in the allowlist. allowed stays false.
  } else if (!user.suspended) {
    allowed = true;
  }
  // else: suspended. allowed stays false.

  let session: string;
  if (allowed) {
    await ensureUser(email);
    const result = await startCustomAuth(email);
    session = result.session;
    // Run the Postmark API call IN PARALLEL with the timing pad. We
    // MUST await sendOtp before returning (see the Lambda-freeze
    // explanation in the comment block above), but we don't want to
    // pay sendOtp's latency on top of the pad. With Promise.all the
    // two run concurrently, so total time is max(sendOtp, pad).
    // Postmark failures are caught and logged — the user sees no email
    // arrive and clicks "Resend code"; we don't want a flaky Postmark
    // call to surface a 500 here.
    await Promise.all([
      sendOtp(email, result.otp).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[request-otp] sendOtp failed:', err);
      }),
      pad(t0, RESPONSE_MIN_MS),
    ]);
  } else {
    // Disallowed or suspended. Return an unredeemable token shaped
    // just like a real one so the client can't tell the difference.
    session = `dn-${crypto.randomBytes(24).toString('base64url')}`;
    await pad(t0, RESPONSE_MIN_MS);
  }

  // CRITICAL: never include the OTP in the response — only the opaque session.
  return c.json({ session });
});

// Same timing-defence rationale as /request-otp: a "fake session"
// (issued for a disallowed email above) rejects in ~50 ms at Cognito's
// session-validation step, while a real-but-wrong code spins Cognito's
// custom-auth-flow for ~200–500 ms. Without padding here, an attacker
// completing the dance with /verify-otp can still enumerate by latency.
//
// The endpoint already returns the same `invalid code` 401 for every
// failure shape. The pad below makes the response *time* match too.
// Successful logins also pay the pad (one-time, on login only) — well
// under the "feels instant" threshold for an explicit user action.
auth.post('/verify-otp', async (c) => {
  const t0 = Date.now();
  const response = await buildVerifyOtpResponse(c);
  await pad(t0, RESPONSE_MIN_MS);
  return response;
});

async function buildVerifyOtpResponse(c: Context): Promise<Response> {
  const parsed = verifyOtpSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const { email, session, code } = parsed.data;

  try {
    const resp = await respondToCustomChallenge(email, session, code);
    const idToken = resp.AuthenticationResult?.IdToken;
    const refreshToken = resp.AuthenticationResult?.RefreshToken;
    if (!idToken || !refreshToken) {
      return c.json({ error: 'invalid code' }, 401);
    }
    const decoded = jwtDecode<{ sub: string; email?: string }>(idToken);
    const cognitoSub = decoded.sub;
    const verifiedEmail = decoded.email ?? email;

    // Locate-or-create the local user row, link Cognito sub.
    //
    // All failure modes below collapse to the same generic 'invalid code'
    // 401 response that a wrong OTP produces. Distinguishing them
    // (suspended, not-in-allowlist, Cognito-sub collision) would leak
    // the same enumeration signal we worked to erase at request-otp.
    let user = await findUserByEmail(verifiedEmail);
    if (!user) {
      // First-user bootstrap. Should only happen when the table is
      // genuinely empty; the /request-otp gate already enforces this,
      // but re-check defensively to close any race.
      const total = await countUsers();
      if (total !== 0) {
        return c.json({ error: 'invalid code' }, 401);
      }
      user = await createFirstAdmin(verifiedEmail, cognitoSub);
    } else if (user.suspended) {
      return c.json({ error: 'invalid code' }, 401);
    } else if (user.cognitoSub == null) {
      // Allowlisted user signing in for the first time — link the sub.
      await linkCognitoSub(user.id, cognitoSub);
    } else if (user.cognitoSub !== cognitoSub) {
      // Different Cognito identity claiming the same email. Shouldn't
      // happen in a single-tenant pool, but closes the edge case of a
      // re-used email after a manual Cognito reset.
      return c.json({ error: 'invalid code' }, 401);
    }

    // Snapshot role + identity into the session row. authMiddleware reads
    // these straight from DDB and never wakes Aurora (or even authUsersTable)
    // for authz checks. Invariant: changes to role/suspension in DDB MUST
    // be paired with session invalidation (see routes/admin.ts).
    const sessionId = await createSession(
      user.id,
      user.email,
      user.roleName,
      refreshToken,
    );

    setCookie(c, 'hereya_sid', sessionId, {
      ...cookieOpts(),
      maxAge: 30 * 24 * 3600,
    });

    return c.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('verify-otp failed:', err);
    return c.json({ error: 'invalid code' }, 401);
  }
}

auth.get('/me', authMiddleware, (c) => {
  const u = c.get('user');
  // `roleName` (not `role`) — the field name must match what
  // apps/frontend/src/components/AuthNav.ts expects so the admin link
  // appears for users whose roleName === 'admin'.
  //
  // `sessionExpiresAt` (Unix seconds) is the DDB session row's TTL.
  // The client caches it so it can decide synchronously whether the
  // session has naturally expired without hitting the network — and so
  // the /admin/* inline gate can redirect-before-paint for expired
  // sessions. Sessions are NOT extended on use; this value is fixed
  // at createSession time.
  return c.json({
    id: u.id,
    email: u.email,
    roleName: u.roleName,
    sessionExpiresAt: c.get('sessionExpiresAt'),
  });
});

auth.post('/logout', async (c) => {
  const sessionId = getCookie(c, 'hereya_sid');
  if (sessionId) {
    try {
      await deleteSession(sessionId);
    } catch {
      // best-effort
    }
  }
  deleteCookie(c, 'hereya_sid', { path: '/' });
  return c.json({ ok: true });
});
