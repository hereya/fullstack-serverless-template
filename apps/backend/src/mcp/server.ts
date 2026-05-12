// Builds a fresh McpServer per request, registers every tool, and
// hands it to the route handler. Per-request construction is the
// cleanest model for stateless Lambda invocations — no shared mutable
// state, no transport-leak concerns when concurrent invocations land
// in the same warm container.
//
// Cost: registering ~7 tools on every request is fast (object literal
// + Map insert). If the tool count grows large, memoize the built
// server keyed on module identity.
//
// To add a new tool: create a `registerXxxTools(server)` function in
// `src/mcp/tools/xxx.ts`, then add the import + call below. The new
// tool is then live without further wiring. See
// `docs/adding-features.md` for the full pattern.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerUserTools } from './tools/users.js';
import { registerRoleTools } from './tools/roles.js';
import { registerSubscriptionsTools } from './tools/subscriptions.js';
import { registerStatsTools } from './tools/stats.js';

export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: 'hereya-fullstack-template',
    version: '0.1.0',
  });
  registerUserTools(server);
  registerRoleTools(server);
  registerSubscriptionsTools(server);
  registerStatsTools(server);
  return server;
}
