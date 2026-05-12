// OAuth 2.1 authorization server for the MCP integration. Implements
// the minimal flow MCP desktop clients (Claude Desktop, custom agents)
// need:
//
//   - GET  /.well-known/oauth-authorization-server  (RFC 8414 metadata)
//   - POST /register   (RFC 7591 Dynamic Client Registration)
//   - GET  /authorize  (browser entry → redirect to /login or consent page)
//   - POST /authorize/confirm  (consent page approval → issues code, redirects)
//   - POST /token      (code exchange + refresh, PKCE-verified)
//
// All routes here are mounted under /api/oauth (see app.ts). The MCP
// spec discovers the auth server URL from the resource metadata served
// by routes/mcp.ts — that points at `<base>/api/oauth` as the issuer.
//
// Public clients only: PKCE-required, no client secrets. That's the
// right fit for desktop MCP apps that can't safely store a secret.
//
// State lives in three Aurora tables (see db/schema.ts):
//   - oauth_clients     (DCR-registered apps)
//   - oauth_auth_codes  (~60 s TTL, single-use)
//   - oauth_tokens      (24h access + 30d refresh, SHA-256 only)

import crypto from 'node:crypto';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { dbCall } from '../db/resilience.js';
import {
  oauthAuthCodes,
  oauthClients,
  oauthTokens,
} from '../db/schema.js';
import { getSession } from '../auth/sessions.js';
import { findUserById } from '../auth/users.js';
import { roleHasPermission } from '../auth/permissions.js';
import { PERMISSIONS } from '../auth/permissions.js';

export const oauth = new Hono();

// -----------------------------------------------------------------------
// Helpers — kept inline so a reader can follow the entire OAuth flow
// without chasing imports.
// -----------------------------------------------------------------------

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

// PKCE S256 verification. Per RFC 7636: base64url-encoded SHA-256 of the
// raw verifier (no JSON, no padding). We accept ONLY S256 (`plain` is
// banned per OAuth 2.1).
function verifyPkce(challenge: string, verifier: string): boolean {
  return crypto.timingSafeEqual(
    Buffer.from(challenge),
    Buffer.from(sha256(verifier)),
  );
}

// Issuer / base URL helpers live in routes/wellKnown.ts where they
// produce the auth-server metadata. The endpoint handlers here don't
// need to know the issuer URL — they just process incoming requests.

const ACCESS_TTL_S = 24 * 60 * 60; // 24h
const REFRESH_TTL_S = 30 * 24 * 60 * 60; // 30d
const CODE_TTL_S = 60; // 60s, single-use

// (RFC 8414 auth-server metadata is served at the host root —
// /.well-known/oauth-authorization-server — by routes/wellKnown.ts.
// Hosting it here under /oauth would require strict-insertion clients
// to fetch /.well-known/oauth-authorization-server/oauth, which we'd
// also need a separate route for. Host-root keeps it canonical.)

// -----------------------------------------------------------------------
// POST /register  — RFC 7591 Dynamic Client Registration
//
// Public clients only (no secret returned). The client supplies a
// human-readable name + at least one redirect_uri. We accept loopback
// (http://127.0.0.1:*) and https://… redirects; that's the standard
// "what's safe for a desktop OAuth client" allowlist.
// -----------------------------------------------------------------------
const registerSchema = z.object({
  client_name: z.string().min(1).max(120),
  redirect_uris: z.array(z.string().url()).min(1).max(5),
  logo_uri: z.string().url().optional(),
  client_uri: z.string().url().optional(),
});

function isAcceptableRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return true;
    if (
      u.protocol === 'http:' &&
      (u.hostname === '127.0.0.1' ||
        u.hostname === '[::1]' ||
        u.hostname === 'localhost')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

oauth.post('/register', async (c) => {
  const parsed = registerSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) return c.json({ error: 'invalid_client_metadata' }, 400);
  const { client_name, redirect_uris, logo_uri, clientUri } = {
    ...parsed.data,
    clientUri: parsed.data.client_uri,
  };
  if (!redirect_uris.every(isAcceptableRedirect)) {
    return c.json(
      {
        error: 'invalid_redirect_uri',
        error_description:
          'redirect_uri must be https:// or a loopback http://127.0.0.1[:port]',
      },
      400,
    );
  }
  const id = `mcp-${randomToken(12)}`;
  await dbCall(
    () =>
      getDb().insert(oauthClients).values({
        id,
        name: client_name,
        redirectUris: JSON.stringify(redirect_uris),
        logoUri: logo_uri,
        clientUri,
      }),
    'oauth.register',
  );
  return c.json(
    {
      client_id: id,
      client_name,
      redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    201,
  );
});

// -----------------------------------------------------------------------
// GET /authorize  — entry point of the OAuth browser flow.
//
// The MCP client opens this in the user's browser. We check the
// `hereya_sid` cookie:
//   - no session → redirect to /login?next=<this-url>
//   - session but user lacks `mcp:connect` → 403 page
//   - session + permission → redirect to the consent page at
//     /oauth/authorize?<same-params> on the FRONTEND, which is an
//     Astro page hosted by Lit. That page calls
//     POST /api/oauth/authorize/confirm on approve.
//
// We park the parsed/validated params in a short-lived signed cookie
// so the confirm POST can replay them without trusting the browser to
// resubmit the exact same values.
// -----------------------------------------------------------------------
const authorizeQuerySchema = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  scope: z.string().default('mcp'),
  state: z.string().optional(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
});

oauth.get('/authorize', async (c) => {
  const parsed = authorizeQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const params = parsed.data;

  // Validate client + redirect_uri match what was registered. Any
  // mismatch is fatal — the OAuth spec calls this out as one of the
  // few errors that MUST NOT redirect back (would leak codes to the
  // attacker's URL).
  const client = await dbCall(
    () =>
      getDb()
        .select()
        .from(oauthClients)
        .where(eq(oauthClients.id, params.client_id))
        .limit(1),
    'oauth.authorize.client',
  );
  if (client.length === 0) {
    return c.json({ error: 'invalid_client' }, 400);
  }
  const allowedRedirects = JSON.parse(
    client[0]!.redirectUris,
  ) as string[];
  if (!allowedRedirects.includes(params.redirect_uri)) {
    return c.json({ error: 'invalid_redirect_uri' }, 400);
  }

  // Require an authenticated session. The `next` param must be a
  // PATH+query — getNextPath() on the login page rejects absolute
  // URLs as an open-redirect defense, so a full-URL `next` would
  // silently fall back to /dashboard after login (dropping the
  // OAuth flow on the floor).
  const reqUrl = new URL(c.req.url);
  const nextPath = encodeURIComponent(reqUrl.pathname + reqUrl.search);
  const sid = getCookie(c, 'hereya_sid');
  if (!sid) {
    return c.redirect(`/login?next=${nextPath}`);
  }
  const session = await getSession(sid);
  if (!session) {
    return c.redirect(`/login?next=${nextPath}`);
  }

  // Require MCP_CONNECT permission. Without it: redirect back to the
  // client with `error=access_denied` (OAuth-standard) so the client
  // shows a clean failure rather than us 403-ing here.
  const allowed = await roleHasPermission(
    session.roleName,
    PERMISSIONS.MCP_CONNECT,
  );
  if (!allowed) {
    const u = new URL(params.redirect_uri);
    u.searchParams.set('error', 'access_denied');
    if (params.state) u.searchParams.set('state', params.state);
    return c.redirect(u.toString());
  }

  // Forward to the frontend consent page. NOT placed under /oauth/*
  // — that whole prefix is owned by this Hono app via the CloudFront
  // behavior, so a /oauth/* path can't reach S3. /connect lives at the
  // root, hits S3, and serves the Astro page that shows the consent
  // UI. On approve, the frontend POSTs to /oauth/authorize/confirm.
  const consent = new URL('/connect', c.req.url);
  for (const [k, v] of new URLSearchParams(c.req.query()).entries()) {
    consent.searchParams.set(k, v);
  }
  return c.redirect(consent.pathname + consent.search);
});

// -----------------------------------------------------------------------
// POST /authorize/confirm  — called by the frontend consent page.
//
// We re-validate everything (including the user's MCP_CONNECT
// permission) since the frontend is just a UI — server-side is the
// source of truth.
// -----------------------------------------------------------------------
oauth.post('/authorize/confirm', async (c) => {
  const parsed = authorizeQuerySchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const params = parsed.data;

  // Re-check client + redirect (no redirect on failure here — this is
  // the consent endpoint, called via fetch from our own frontend; we
  // return JSON for it to handle).
  const client = await dbCall(
    () =>
      getDb()
        .select()
        .from(oauthClients)
        .where(eq(oauthClients.id, params.client_id))
        .limit(1),
    'oauth.authorize.confirm.client',
  );
  if (client.length === 0) return c.json({ error: 'invalid_client' }, 400);
  const allowedRedirects = JSON.parse(
    client[0]!.redirectUris,
  ) as string[];
  if (!allowedRedirects.includes(params.redirect_uri)) {
    return c.json({ error: 'invalid_redirect_uri' }, 400);
  }

  const sid = getCookie(c, 'hereya_sid');
  if (!sid) return c.json({ error: 'login_required' }, 401);
  const session = await getSession(sid);
  if (!session) return c.json({ error: 'login_required' }, 401);
  const allowed = await roleHasPermission(
    session.roleName,
    PERMISSIONS.MCP_CONNECT,
  );
  if (!allowed) return c.json({ error: 'forbidden' }, 403);

  // Issue the code. Single-use, ~60s TTL — all time arithmetic stays
  // in Postgres via NOW() + INTERVAL so we never round-trip a JS Date
  // through the Aurora Data API. (Drizzle's aws-data-api driver
  // applies the cluster's session timezone offset on insert, which
  // can shift the stored value by hours from what `new Date()` meant.
  // See the earlier "code expired" misfire on the dev cluster.)
  const code = randomToken();
  await dbCall(
    () =>
      getDb()
        .insert(oauthAuthCodes)
        .values({
          code,
          clientId: params.client_id,
          userId: session.userId,
          redirectUri: params.redirect_uri,
          codeChallenge: params.code_challenge,
          codeChallengeMethod: params.code_challenge_method,
          scope: params.scope,
          expiresAt: sql`NOW() + INTERVAL '${sql.raw(String(CODE_TTL_S))} seconds'` as unknown as Date,
        }),
    'oauth.authorize.confirm.insert',
  );

  // Build the redirect URL with `?code=…&state=…`. The frontend will
  // navigate to this — it isn't an HTTP redirect from this endpoint
  // (we return JSON for the Lit component to handle).
  const u = new URL(params.redirect_uri);
  u.searchParams.set('code', code);
  if (params.state) u.searchParams.set('state', params.state);
  return c.json({ redirectTo: u.toString() });
});

// -----------------------------------------------------------------------
// POST /token  — code exchange OR refresh.
//
// Two flavors:
//   grant_type=authorization_code  → consume the code, verify PKCE,
//                                    issue a fresh (access, refresh) pair.
//   grant_type=refresh_token       → consume the old refresh, issue a
//                                    fresh pair (refresh rotation).
//
// Refresh rotation: every refresh exchange invalidates the old refresh
// token. Mitigates token-theft replays — a stolen refresh works once
// then the original client's next refresh fails, alerting the user.
// -----------------------------------------------------------------------
const tokenAuthCodeSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  code_verifier: z.string().min(43).max(128),
});

const tokenRefreshSchema = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string().min(1),
  client_id: z.string().min(1),
});

type ParsedTokenBody =
  | z.infer<typeof tokenAuthCodeSchema>
  | z.infer<typeof tokenRefreshSchema>;

async function parseTokenBody(req: Request): Promise<ParsedTokenBody | null> {
  // OAuth allows form-encoded OR JSON. Accept both.
  const ct = req.headers.get('content-type') ?? '';
  let raw: Record<string, unknown>;
  if (ct.includes('application/json')) {
    try {
      raw = (await req.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else {
    const text = await req.text();
    const params = new URLSearchParams(text);
    raw = Object.fromEntries(params);
  }
  const grant = raw.grant_type;
  if (grant === 'authorization_code') {
    const r = tokenAuthCodeSchema.safeParse(raw);
    return r.success ? r.data : null;
  }
  if (grant === 'refresh_token') {
    const r = tokenRefreshSchema.safeParse(raw);
    return r.success ? r.data : null;
  }
  return null;
}

async function issueTokenPair(opts: {
  clientId: string;
  userId: string;
  scope: string;
}): Promise<{ access: string; refresh: string }> {
  const access = randomToken();
  const refresh = randomToken();
  // Same DB-side time arithmetic story as the auth-code insert above —
  // never round-trip a JS Date through the Aurora Data API for an
  // expiration that the DB itself will check.
  await dbCall(
    () =>
      getDb()
        .insert(oauthTokens)
        .values({
          accessTokenHash: sha256(access),
          refreshTokenHash: sha256(refresh),
          clientId: opts.clientId,
          userId: opts.userId,
          scope: opts.scope,
          accessExpiresAt: sql`NOW() + INTERVAL '${sql.raw(String(ACCESS_TTL_S))} seconds'` as unknown as Date,
          refreshExpiresAt: sql`NOW() + INTERVAL '${sql.raw(String(REFRESH_TTL_S))} seconds'` as unknown as Date,
        }),
    'oauth.token.issue',
  );
  return { access, refresh };
}

oauth.post('/token', async (c) => {
  const body = await parseTokenBody(c.req.raw);
  if (!body) {
    // eslint-disable-next-line no-console
    console.warn('[oauth.token] invalid_request — could not parse body');
    return c.json({ error: 'invalid_request' }, 400);
  }

  if (body.grant_type === 'authorization_code') {
    // Look up the code, single-use semantics: SELECT then UPDATE
    // consumed_at. A real race-tolerant impl would use a conditional
    // UPDATE returning the row; this two-step is acceptable for the
    // template since codes are 60s TTL and single-use enforcement is
    // belt-and-suspenders.
    // Pull a server-side "expired" flag alongside the row. Doing the
    // comparison in Postgres avoids the JS-Date / Aurora-Data-API
    // timezone round-trip that previously caused codes to look ~2h
    // expired the instant they were minted.
    const rows = await dbCall(
      () =>
        getDb()
          .select({
            code: oauthAuthCodes.code,
            clientId: oauthAuthCodes.clientId,
            userId: oauthAuthCodes.userId,
            redirectUri: oauthAuthCodes.redirectUri,
            codeChallenge: oauthAuthCodes.codeChallenge,
            codeChallengeMethod: oauthAuthCodes.codeChallengeMethod,
            scope: oauthAuthCodes.scope,
            expiresAt: oauthAuthCodes.expiresAt,
            consumedAt: oauthAuthCodes.consumedAt,
            expired: sql<boolean>`${oauthAuthCodes.expiresAt} < NOW()`,
          })
          .from(oauthAuthCodes)
          .where(eq(oauthAuthCodes.code, body.code))
          .limit(1),
      'oauth.token.code',
    );
    const row = rows[0];
    // Surface WHICH check fails. Each branch returns the same
    // RFC-conformant `invalid_grant` to the client (the client must
    // not learn anything from us), but in the server log we want to
    // know precisely.
    if (!row) {
      // eslint-disable-next-line no-console
      console.warn('[oauth.token] invalid_grant — code not found', {
        codePrefix: body.code.slice(0, 6),
      });
      return c.json({ error: 'invalid_grant' }, 400);
    }
    if (row.consumedAt) {
      // eslint-disable-next-line no-console
      console.warn('[oauth.token] invalid_grant — code already consumed', {
        consumedAt: row.consumedAt,
      });
      return c.json({ error: 'invalid_grant' }, 400);
    }
    if (row.expired) {
      // eslint-disable-next-line no-console
      console.warn('[oauth.token] invalid_grant — code expired', {
        expiresAt: row.expiresAt,
      });
      return c.json({ error: 'invalid_grant' }, 400);
    }
    if (row.clientId !== body.client_id) {
      // eslint-disable-next-line no-console
      console.warn('[oauth.token] invalid_grant — client_id mismatch', {
        stored: row.clientId,
        sent: body.client_id,
      });
      return c.json({ error: 'invalid_grant' }, 400);
    }
    if (row.redirectUri !== body.redirect_uri) {
      // eslint-disable-next-line no-console
      console.warn('[oauth.token] invalid_grant — redirect_uri mismatch', {
        stored: row.redirectUri,
        sent: body.redirect_uri,
      });
      return c.json({ error: 'invalid_grant' }, 400);
    }
    if (!verifyPkce(row.codeChallenge, body.code_verifier)) {
      // eslint-disable-next-line no-console
      console.warn('[oauth.token] invalid_grant — PKCE verifier mismatch', {
        storedChallengeLen: row.codeChallenge.length,
        sentVerifierLen: body.code_verifier.length,
      });
      return c.json({ error: 'invalid_grant' }, 400);
    }
    await dbCall(
      () =>
        getDb()
          .update(oauthAuthCodes)
          .set({ consumedAt: new Date() })
          .where(eq(oauthAuthCodes.code, body.code)),
      'oauth.token.code.consume',
    );

    const { access, refresh } = await issueTokenPair({
      clientId: row.clientId,
      userId: row.userId,
      scope: row.scope,
    });
    return c.json({
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      scope: row.scope,
    });
  }

  // grant_type === 'refresh_token'
  const refreshHash = sha256(body.refresh_token);
  // DB-side `> NOW()` to dodge the aws-data-api JS-Date timezone shift.
  const rows = await dbCall(
    () =>
      getDb()
        .select()
        .from(oauthTokens)
        .where(
          and(
            eq(oauthTokens.refreshTokenHash, refreshHash),
            eq(oauthTokens.clientId, body.client_id),
            isNull(oauthTokens.revokedAt),
            sql`${oauthTokens.refreshExpiresAt} > NOW()`,
          ),
        )
        .limit(1),
    'oauth.token.refresh.lookup',
  );
  const row = rows[0];
  if (!row) return c.json({ error: 'invalid_grant' }, 400);

  // Rotate: revoke the old pair and issue a new one.
  await dbCall(
    () =>
      getDb()
        .update(oauthTokens)
        .set({ revokedAt: new Date() })
        .where(eq(oauthTokens.id, row.id)),
    'oauth.token.refresh.revoke',
  );
  const { access, refresh } = await issueTokenPair({
    clientId: row.clientId,
    userId: row.userId,
    scope: row.scope,
  });
  return c.json({
    access_token: access,
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    scope: row.scope,
  });
});

// -----------------------------------------------------------------------
// Helpers exported for use by the bearer-token middleware and the
// /admin/integrations management page.
// -----------------------------------------------------------------------
export { sha256 as sha256TokenHash };

// Resolve a bearer token to the active token row + user. Returns null
// for any failure (expired, revoked, unknown). The middleware in
// auth/mcpAuth.ts wraps this; admin/integrations lists rows directly.
export async function resolveAccessToken(token: string): Promise<{
  tokenId: string;
  userId: string;
  clientId: string;
  scope: string;
  accessExpiresAt: Date;
} | null> {
  const hash = sha256(token);
  // DB-side `> NOW()` to dodge the aws-data-api JS-Date timezone shift.
  const rows = await dbCall(
    () =>
      getDb()
        .select()
        .from(oauthTokens)
        .where(
          and(
            eq(oauthTokens.accessTokenHash, hash),
            isNull(oauthTokens.revokedAt),
            sql`${oauthTokens.accessExpiresAt} > NOW()`,
          ),
        )
        .limit(1),
    'oauth.resolveAccessToken',
  );
  const r = rows[0];
  if (!r) return null;
  // Also confirm the user still exists; a soft-deleted user shouldn't
  // ride a stale token.
  const user = await findUserById(r.userId);
  if (!user) return null;
  return {
    tokenId: r.id,
    userId: r.userId,
    clientId: r.clientId,
    scope: r.scope,
    accessExpiresAt: r.accessExpiresAt,
  };
}
