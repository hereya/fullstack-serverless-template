import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import { statsSummaryHandler } from '../handlers/stats.js';
import { ok, withPermission } from '../toolHelpers.js';

export function registerStatsTools(server: McpServer): void {
  server.registerTool(
    'stats_summary',
    {
      description:
        'Aggregate counts for the app: users (DDB authUsers) and public-form registrations (DDB registrationsTable).',
      inputSchema: {},
    },
    async (_args, extra) =>
      withPermission(extra, PERMISSIONS.STATS_VIEW, async () => {
        const stats = await statsSummaryHandler();
        return ok(
          stats,
          `${stats.userCount} users · ${stats.registrationCount} registrations`,
        );
      }),
  );
}
