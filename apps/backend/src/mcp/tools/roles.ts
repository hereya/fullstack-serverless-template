import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import {
  listRolesHandler,
  updateRolePermissionsHandler,
} from '../handlers/roles.js';
import { ok, withPermission } from '../toolHelpers.js';

export function registerRoleTools(server: McpServer): void {
  server.registerTool(
    'roles_list',
    {
      description:
        'List every role and the permission identifiers it currently grants.',
      inputSchema: {},
    },
    async (_args, extra) =>
      withPermission(extra, PERMISSIONS.ROLES_LIST, async () => {
        const roles = await listRolesHandler();
        return ok({ roles }, `Found ${roles.length} role(s).`);
      }),
  );

  server.registerTool(
    'roles_update_permissions',
    {
      description:
        'Replace the permission set granted by a role. Effect propagates to all members of that role on their next request.',
      inputSchema: {
        roleName: z.string().min(1),
        permissions: z.array(z.string()).min(0),
      },
    },
    async ({ roleName, permissions }, extra) =>
      withPermission(extra, PERMISSIONS.ROLES_UPDATE, async () => {
        const role = await updateRolePermissionsHandler({
          roleName,
          permissions,
        });
        return ok(
          { role },
          `Updated role '${roleName}' to grant ${permissions.length} permission(s).`,
        );
      }),
  );
}
