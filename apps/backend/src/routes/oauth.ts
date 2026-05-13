// OAuth 2.1 authorization server for the MCP integration. Implements
// the minimal flow MCP desktop clients (Claude Desktop, custom agents)
// need:
//
//   - GET  /.well-known/oauth-authorization-server  (RFC 8414 metadata,
//     served by routes/wellKnown.ts at the host root)
//   - POST /register   (RFC 7591 Dynamic Client Registration)
//   - GET  /authorize  (browser entry → redirect to /login or consent page)
//   - POST /authorize/confirm  (consent page approval → issues code, redirects)
//   - POST /token      (code exchange + refresh, PKCE-verified)
//
// All routes here are mounted under /oauth (see app.ts).
//
// Public clients only: PKCE-required, no client secrets. That's the
// right fit for desktop MCP apps that can't safely store a secret.
//
// State lives in DDB via auth/oauthStore.ts (single-table design backed
// by hereya/aws-ddb-app-state). No Aurora — bearer-token lookups stay
// off the cold-start path of the user-facing /mcp endpoint.

import crypto from 'node:crypto';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { getSession } from '../auth/sessions.js';
import { findUserById } from '../auth/users.js';
import { roleHasPermission, PERMISSIONS } from '../auth/permissions.js';
import {
  consumeCode,
  createClient,
  createCode,
  createToken,
  getClient,
  getCode,
  getTokenByAccessHash,
  getTokenByRefreshHash,
  revokeToken,
} from '../auth/oauthStore.js';

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

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const ACCESS_TTL_S = 24 * 60 * 60; // 24h
const REFRESH_TTL_S = 30 * 24 * 60 * 60; // 30d
const CODE_TTL_S = 60; // 60s, single-use

// -----------------------------------------------------------------------
// POST /register  — RFC 7591 Dynamic Client Registration
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
  const { client_name, redirect_uris, logo_uri, client_uri } = parsed.data;
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
  await createClient({
    clientId: id,
    name: client_name,
    redirectUris: redirect_uris,
    logoUri: logo_uri,
    clientUri: client_uri,
    createdAt: new Date().toISOString(),
  });
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
  const client = await getClient(params.client_id);
  if (!client) {
    return c.json({ error: 'invalid_client' }, 400);
  }
  if (!client.redirectUris.includes(params.redirect_uri)) {
    return c.json({ error: 'invalid_redirect_uri' }, 400);
  }

  // Require an authenticated session.
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

  // Forward to the frontend consent page (Astro at /connect).
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

  const client = await getClient(params.client_id);
  if (!client) return c.json({ error: 'invalid_client' }, 400);
  if (!client.redirectUris.includes(params.redirect_uri)) {
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

  // Issue the code. Single-use, 60s TTL.
  const code = randomToken();
  await createCode({
    code,
    clientId: params.client_id,
    userId: session.userId,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
    codeChallengeMethod: params.code_challenge_method,
    scope: params.scope,
    expiresAt: nowSeconds() + CODE_TTL_S,
  });

  // Build the redirect URL with `?code=…&state=…`. Returned as JSON so
  // the Lit component on the consent page can navigate the browser.
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
// token (revokeToken). Mitigates theft replays — a stolen refresh works
// once then the original client's next refresh fails, alerting the user.
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
  await createToken({
    accessTokenHash: sha256(access),
    refreshTokenHash: sha256(refresh),
    clientId: opts.clientId,
    userId: opts.userId,
    scope: opts.scope,
    accessExpiresAt: nowSeconds() + ACCESS_TTL_S,
    refreshExpiresAt: nowSeconds() + REFRESH_TTL_S,
  });
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
    // Surface WHICH check fails. Each branch returns the same
    // RFC-conformant `invalid_grant` to the client (the client must
    // not learn anything from us), but in the server log we want to
    // know precisely.
    const code = await getCode(body.code);
    if (!code) {
      // eslint-disable-next-line no-console
      console.warn('[oauth.token] invalid_grant — code missing or expired', {
        codePrefix: body.code.slice(0, 6),
      });
      return c.json({ error: 'invalid_grant' }, 400);
    }
    if (code.clientId !== body.client_id) {
      // eslint-disable-next-line no-console
      console.warn('[oauth.token] invalid_grant — client_id mismatch', {
        stored: code.clientId,
        sent: body.client_id,
      });
      return c.json({ error: 'invalid_grant' }, 400);
    }
    if (code.redirectUri !== body.redirect_uri) {
      // eslint-disable-next-line no-console
      console.warn('[oauth.token] invalid_grant — redirect_uri mismatch', {
        stored: code.redirectUri,
        sent: body.redirect_uri,
      });
      return c.json({ error: 'invalid_grant' }, 400);
    }
    if (!verifyPkce(code.codeChallenge, body.code_verifier)) {
      // eslint-disable-next-line no-console
      console.warn('[oauth.token] invalid_grant — PKCE verifier mismatch');
      return c.json({ error: 'invalid_grant' }, 400);
    }
    // Single-use enforcement: atomic delete. Losers (concurrent replays)
    // get false and we 400 them — the winner proceeds to issue tokens.
    const won = await consumeCode(body.code);
    if (!won) {
      // eslint-disable-next-line no-console
      console.warn('[oauth.token] invalid_grant — code already consumed');
      return c.json({ error: 'invalid_grant' }, 400);
    }

    const { access, refresh } = await issueTokenPair({
      clientId: code.clientId,
      userId: code.userId,
      scope: code.scope,
    });
    return c.json({
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      scope: code.scope,
    });
  }

  // grant_type === 'refresh_token'
  const refreshHash = sha256(body.refresh_token);
  const tok = await getTokenByRefreshHash(refreshHash);
  if (!tok) return c.json({ error: 'invalid_grant' }, 400);
  if (tok.clientId !== body.client_id) {
    return c.json({ error: 'invalid_grant' }, 400);
  }

  // Rotate: revoke the old pair and issue a new one.
  await revokeToken(tok.accessTokenHash);
  const { access, refresh } = await issueTokenPair({
    clientId: tok.clientId,
    userId: tok.userId,
    scope: tok.scope,
  });
  return c.json({
    access_token: access,
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    scope: tok.scope,
  });
});

// -----------------------------------------------------------------------
// Helpers exported for use by the bearer-token middleware and the
// /admin/integrations management page.
// -----------------------------------------------------------------------
export { sha256 as sha256TokenHash };

/**
 * Resolve a bearer token to the active token row + user. Returns null
 * for any failure (expired, revoked, unknown). The middleware in
 * auth/mcpAuth.ts wraps this; admin/integrations lists rows directly
 * via listTokensByUser.
 */
export async function resolveAccessToken(token: string): Promise<{
  tokenId: string;
  userId: string;
  clientId: string;
  scope: string;
  accessExpiresAt: number;
} | null> {
  const hash = sha256(token);
  const tok = await getTokenByAccessHash(hash);
  if (!tok) return null;
  // Confirm the user still exists; a soft-deleted user shouldn't ride a
  // stale token.
  const user = await findUserById(tok.userId);
  if (!user) return null;
  return {
    tokenId: tok.tokenId,
    userId: tok.userId,
    clientId: tok.clientId,
    scope: tok.scope,
    accessExpiresAt: tok.accessExpiresAt,
  };
}
