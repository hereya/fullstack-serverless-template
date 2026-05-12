import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import { listSubscriptionsHandler } from '../handlers/subscriptions.js';
import { ok, withPermission } from '../toolHelpers.js';

export function registerSubscriptionsTools(server: McpServer): void {
  server.registerTool(
    'subscriptions_list',
    {
      description:
        'List newsletter subscriptions captured by the public /subscribe form. Most-recent first.',
      inputSchema: {
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async ({ limit }, extra) =>
      withPermission(extra, PERMISSIONS.NEWSLETTER_LIST, async () => {
        const subscriptions = await listSubscriptionsHandler({ limit });
        return ok(
          { subscriptions },
          `Found ${subscriptions.length} subscription(s).`,
        );
      }),
  );
}
