import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import {
  deleteRegistrationHandler,
  listRegistrationsHandler,
} from '../handlers/registrations.js';
import { ok, withPermission } from '../toolHelpers.js';

export function registerRegistrationsTools(server: McpServer): void {
  server.registerTool(
    'registrations_list',
    {
      description:
        'List entries from the public registration form. Most-recent first. Each row carries email + createdAt plus any custom fields the project\'s form captures.',
      inputSchema: {
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async ({ limit }, extra) =>
      withPermission(extra, PERMISSIONS.REGISTRATIONS_LIST, async () => {
        const registrations = await listRegistrationsHandler({ limit });
        return ok(
          { registrations },
          `Found ${registrations.length} registration(s).`,
        );
      }),
  );

  server.registerTool(
    'registrations_delete',
    {
      description:
        'Remove a registration by email. Idempotent: deleting a non-existent registration is a no-op.',
      inputSchema: {
        email: z.string().email(),
      },
    },
    async ({ email }, extra) =>
      withPermission(extra, PERMISSIONS.REGISTRATIONS_DELETE, async () => {
        await deleteRegistrationHandler(email);
        return ok({ email }, `Deleted registration for ${email}.`);
      }),
  );
}
