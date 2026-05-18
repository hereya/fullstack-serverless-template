// Two well-known OAuth/MCP metadata documents, both served at the
// host root so RFC 8414 / RFC 9728 strict path derivation works
// unambiguously for every OAuth client SDK.
//
// /.well-known/oauth-protected-resource
//   RFC 9728. MCP clients hit /mcp without auth, get 401 with a
//   WWW-Authenticate header pointing here (set by mcpAuth.ts), then
//   fetch this document to discover the authorization server.
//
// /.well-known/oauth-authorization-server
//   RFC 8414. The client derives this URL by inserting the
//   well-known path between the issuer's host and path. We declare
//   issuer = host root (no path), so the derived URL is just
//   `<host>/.well-known/oauth-authorization-server` — one canonical
//   location, no append-vs-insert ambiguity. Endpoints live under
//   /oauth/* and are advertised in the document.

import { Hono } from 'hono';

export const wellKnown = new Hono();

function baseUrl(req: Request): string {
  // `appUrl` is injected into the Lambda env by hereya/aws-app-lambda
  // (>= 0.4.1) as the canonical public URL — it's the same value as
  // the package's `appUrl` CfnOutput, mirrored to runtime.
  //
  // We can't derive the public URL from `req.url` behind CloudFront:
  // the ALL_VIEWER_EXCEPT_HOST_HEADER origin request policy strips
  // the public Host header (AND any client-supplied X-Forwarded-Host)
  // before forwarding, so `req.url` surfaces the API Gateway origin
  // instead. If the discovery doc returned that URL, OAuth clients
  // would send the browser to the origin — which has no /login
  // handler and 404s. The `appUrl` branch fires in production; the
  // X-Forwarded-* branch below is unreachable there.
  if (process.env.appUrl) {
    return new URL('/', process.env.appUrl).toString().replace(/\/$/, '');
  }
  // Local dev: Vite's proxy (xfwd: true in astro.config.mjs) forwards
  // X-Forwarded-Host / -Proto pointing at the frontend port (:4321),
  // so the discovery doc advertises the URL the MCP client actually
  // used instead of the backend's :4000 origin.
  const fwdHost = req.headers.get('x-forwarded-host');
  const fwdProto = req.headers.get('x-forwarded-proto');
  if (fwdHost) {
    const proto = fwdProto ?? 'http';
    return `${proto}://${fwdHost}`;
  }
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}`;
}

wellKnown.get('/oauth-protected-resource', (c) => {
  const base = baseUrl(c.req.raw);
  return c.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
    resource_documentation: `${base}/docs/mcp.md`,
  });
});

wellKnown.get('/oauth-authorization-server', (c) => {
  const base = baseUrl(c.req.raw);
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], // public PKCE-only clients
    scopes_supported: ['mcp'],
  });
});
