// Bearer-token middleware for /api/mcp.
//
// Mirrors the shape of middleware/auth.ts (cookie-based session) but
// uses an OAuth bearer token issued by routes/oauth.ts.
//
//   - Extracts `Authorization: Bearer <token>`
//   - Resolves the token via resolveAccessToken() — checks
//     not-expired, not-revoked, user still exists
//   - On success: c.set('user', AuthUser) so downstream code (the MCP
//     server's per-tool permission checks via roleHasPermission) sees
//     the SAME shape that authMiddleware sets, no special-casing.
//   - No role check here — every MCP tool checks its own permission.
//     Tokens are issued only to users who have MCP_CONNECT (gated at
//     the OAuth /authorize step), so a non-eligible user can't even
//     get a token in the first place.

import type { Context, Next } from 'hono';
import { resolveAccessToken } from '../routes/oauth.js';
import { findUserById } from './users.js';

// Augment Hono context to expose the token id for revocation logging
// and the resolved client id (useful for admin/integrations).
declare module 'hono' {
  interface ContextVariableMap {
    mcpTokenId: string;
    mcpClientId: string;
  }
}

function bearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authHeader);
  return m ? m[1]! : null;
}

function publicBaseUrl(c: Context): string {
  // Mirrors routes/wellKnown.ts:baseUrl(). The discovery URL we
  // advertise in WWW-Authenticate MUST match the URL the MCP client
  // used, or the client rejects the resource as mismatched.
  //
  // Behind CloudFront: trust appUrl (injected by hereya/aws-app-lambda
  // >= 0.4.1). The ALL_VIEWER_EXCEPT_HOST_HEADER origin request policy
  // strips Host AND any client-supplied X-Forwarded-Host, so this
  // branch fires in prod and the X-Forwarded-* branch below is
  // unreachable there.
  if (process.env.appUrl) {
    return new URL('/', process.env.appUrl).toString().replace(/\/$/, '');
  }
  // Local dev: Vite's proxy (xfwd: true) forwards X-Forwarded-Host /
  // -Proto pointing at the frontend port (:4321), so we surface the
  // URL the MCP client actually used instead of the backend's :4000.
  const fwdHost = c.req.header('x-forwarded-host');
  const fwdProto = c.req.header('x-forwarded-proto');
  if (fwdHost) {
    const proto = fwdProto ?? 'http';
    return `${proto}://${fwdHost}`;
  }
  return new URL(c.req.url).origin;
}

function unauthorized(c: Context): Response {
  // Per RFC 9728 + MCP auth spec, surface a WWW-Authenticate header
  // pointing at our resource metadata so the client knows where to
  // start the OAuth flow.
  const base = publicBaseUrl(c);
  c.header(
    'WWW-Authenticate',
    `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
  );
  return c.json({ error: 'unauthorized' }, 401);
}

export async function mcpAuthMiddleware(c: Context, next: Next) {
  const token = bearerToken(c.req.header('Authorization'));
  if (!token) return unauthorized(c);

  const resolved = await resolveAccessToken(token);
  if (!resolved) return unauthorized(c);

  // Hydrate the same AuthUser shape that authMiddleware sets — the
  // permission middleware doesn't care whether the auth came from a
  // cookie or a bearer.
  const user = await findUserById(resolved.userId);
  if (!user || user.suspended) return unauthorized(c);
  c.set('user', {
    id: user.id,
    sub: user.cognitoSub,
    email: user.email,
    roleName: user.roleName,
  });
  c.set('mcpTokenId', resolved.tokenId);
  c.set('mcpClientId', resolved.clientId);
  await next();
}
