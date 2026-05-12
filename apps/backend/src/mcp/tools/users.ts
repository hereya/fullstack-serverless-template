import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import {
  addUserHandler,
  listUsersHandler,
  setSuspendedHandler,
} from '../handlers/users.js';
import { ok, withPermission } from '../toolHelpers.js';

// Per-tool permission gates mirror the HTTP route's `requirePermission`
// in routes/admin.ts. Both surfaces share the same handler module, so
// when you add a new user-mutation route you only need to register a
// matching tool here. See docs/adding-features.md for the recipe.
export function registerUserTools(server: McpServer): void {
  server.registerTool(
    'users_list',
    {
      description:
        'List every user on the allowlist (id, email, role, suspended, signed-in?).',
      inputSchema: {},
    },
    async (_args, extra) =>
      withPermission(extra, PERMISSIONS.USERS_LIST, async () => {
        const users = await listUsersHandler();
        return ok({ users }, `Found ${users.length} user(s).`);
      }),
  );

  server.registerTool(
    'users_add',
    {
      description:
        'Add an email to the allowlist (member role). User must complete email-OTP login to activate.',
      inputSchema: {
        email: z.string().email(),
      },
    },
    async ({ email }, extra) =>
      withPermission(extra, PERMISSIONS.USERS_ADD, async () => {
        const user = await addUserHandler(email);
        return ok({ user }, `Added ${email}.`);
      }),
  );

  server.registerTool(
    'users_set_suspended',
    {
      description:
        'Suspend (or unsuspend) a user. Suspended users have their sessions terminated immediately. The last active admin cannot be suspended.',
      inputSchema: {
        userId: z.string().uuid(),
        suspended: z.boolean(),
      },
    },
    async ({ userId, suspended }, extra) =>
      withPermission(extra, PERMISSIONS.USERS_SUSPEND, async () => {
        const user = await setSuspendedHandler(userId, suspended);
        return ok(
          { user },
          `${suspended ? 'Suspended' : 'Unsuspended'} ${user.email}.`,
        );
      }),
  );
}
