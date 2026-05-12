// MCP Streamable-HTTP endpoint at /mcp.
//
// Stateless: each request builds its own McpServer + transport,
// processes one JSON-RPC request, returns. No sessions, no SSE — fits
// the Lambda execution model (handler freeze on response, no
// background work) without ceremony.
//
// Pipeline per request:
//   1. mcpAuthMiddleware runs first. It pulls the bearer token,
//      validates it via routes/oauth.ts:resolveAccessToken, hydrates
//      `c.get('user')` so per-tool permission checks see the same
//      AuthUser shape that cookie-auth produces.
//   2. We build a fresh McpServer (registers tools), wire it to a
//      stateless transport, and pass the request through.
//   3. The transport returns a Web-Standard Response object which we
//      return directly from the Hono route.
//
// The transport's `authInfo.extra.user` is read by toolHelpers'
// `withPermission()` to scope each tool call.

import { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { mcpAuthMiddleware } from '../auth/mcpAuth.js';
import { buildMcpServer } from '../mcp/server.js';

export const mcp = new Hono();

// Streamable-HTTP transport has two methods on the same URL:
//   POST /mcp  — JSON-RPC requests (this is the channel we serve)
//   GET  /mcp  — long-lived SSE stream so the server can push
//                server-initiated messages (sampling, elicitation,
//                progress, log notifications) back to the client.
//
// We don't support server-initiated messages (all tools return
// synchronously, no sampling, no progress). Per the spec the right
// signal for that is 405 Method Not Allowed on GET — well-behaved
// clients stop retrying. Without this, Claude Code reopens the GET
// stream every ~80 ms and each retry burns an Aurora round-trip on
// the bearer-token check. Short-circuit here, before the auth
// middleware, so the rejection is free.
mcp.get('/', (c) => c.body(null, 405, { Allow: 'POST' }));
mcp.delete('/', (c) => c.body(null, 405, { Allow: 'POST' }));

mcp.use('*', mcpAuthMiddleware);

mcp.all('/', async (c) => {
  // Stateless: sessionIdGenerator omitted = no session management.
  // enableJsonResponse: true → plain JSON responses, no SSE. API
  // Gateway's HTTP API buffers responses so SSE wouldn't stream
  // through cleanly anyway, and our tools all return synchronously.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  const server = buildMcpServer();
  await server.connect(transport);

  try {
    return await transport.handleRequest(c.req.raw, {
      authInfo: {
        // The SDK wants an AuthInfo. We use it as a side-channel to
        // pass the resolved AuthUser into tool callbacks via
        // `extra.authInfo.extra.user`.
        token: c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') ?? '',
        clientId: c.get('mcpClientId'),
        scopes: ['mcp'],
        extra: {
          user: c.get('user'),
          tokenId: c.get('mcpTokenId'),
        },
      },
    });
  } finally {
    // Close the transport so its internal resources (in-memory stream
    // buffers, etc.) don't leak across Lambda invocations.
    await transport.close();
  }
});
