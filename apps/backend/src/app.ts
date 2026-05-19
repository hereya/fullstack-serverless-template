import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { admin } from './routes/admin.js';
import { auth } from './routes/auth.js';
import { mcp } from './routes/mcp.js';
import { oauth } from './routes/oauth.js';
import { publicRoutes } from './routes/public.js';
import { registration } from './routes/registration.js';
import { webauthn } from './routes/webauthn.js';
import { wellKnown } from './routes/wellKnown.js';

export const app = new Hono();

// Request logger. Off in tests (vitest mocks would dirty output);
// on in dev + production.
if (process.env.NODE_ENV !== 'test') {
  app.use('*', logger());
}

app.route('/api', publicRoutes);
app.route('/api/auth', auth);
app.route('/api/registration', registration); // public (no auth)
app.route('/api/webauthn', webauthn);         // mixed: register/* + credentials* authed, authenticate/* anonymous
app.route('/api/admin', admin);                // auth-gated + per-route requirePermission

// MCP integration. These three trees live OUTSIDE /api/* because the
// MCP auth spec mandates specific URLs:
//   /.well-known/oauth-protected-resource  (RFC 9728)
//   /oauth/.well-known/oauth-authorization-server  (RFC 8414, via append)
//   /mcp                                   (the MCP server endpoint)
// The hereya/aws-app-lambda package (>= 0.4.0) routes all three to
// the Lambda via dedicated CloudFront behaviors.
app.route('/.well-known', wellKnown);
app.route('/oauth', oauth);
app.route('/mcp', mcp);

app.onError((err, c) => {
  // eslint-disable-next-line no-console
  console.error('unhandled error', err);
  return c.json({ error: 'internal server error' }, 500);
});
