// Admin HTTP surface. Every route here is a thin adapter over a
// shared handler in src/mcp/handlers/ — the same handler is also
// invoked from the matching MCP tool in src/mcp/tools/. The two
// surfaces are gated on the SAME permission constant, so they stay
// in lockstep on both behavior and authorization.
//
// Convention reminder: when you add a new admin route here, you MUST
// also add the matching MCP tool. See docs/patterns/*.md for examples
// of adding new admin features (notes, attachments, etc.).

import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { PERMISSIONS } from '../auth/permissions.js';
import {
  addUserHandler,
  EmailAlreadyExistsError,
  LastAdminError,
  listUsersHandler,
  setSuspendedHandler,
  UserNotFoundError,
} from '../mcp/handlers/users.js';
import {
  deleteRegistrationHandler,
  listRegistrationsHandler,
} from '../mcp/handlers/registrations.js';
import {
  ConnectionNotFoundError,
  listConnectionsHandler,
  revokeConnectionHandler,
} from '../mcp/handlers/integrations.js';

export const admin = new Hono();

admin.use('*', authMiddleware);

const addUserSchema = z.object({ email: z.string().email() });
const suspendSchema = z.object({ suspended: z.boolean() });

admin.get('/users', requirePermission(PERMISSIONS.USERS_LIST), async (c) => {
  const users = await listUsersHandler();
  return c.json(users);
});

admin.post('/users', requirePermission(PERMISSIONS.USERS_ADD), async (c) => {
  const parsed = addUserSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  try {
    const user = await addUserHandler(parsed.data.email);
    return c.json(user, 201);
  } catch (err) {
    if (err instanceof EmailAlreadyExistsError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
});

admin.patch(
  '/users/:id',
  requirePermission(PERMISSIONS.USERS_SUSPEND),
  async (c) => {
    const id = c.req.param('id');
    const parsed = suspendSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
    try {
      const user = await setSuspendedHandler(id, parsed.data.suspended);
      return c.json(user);
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        return c.json({ error: err.message }, 404);
      }
      if (err instanceof LastAdminError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
  },
);

// -------- Registrations (admin) --------
//
// Lists rows from the public registrations DDB table so admins can see
// who has signed up via the /register page. Gated by REGISTRATIONS_LIST
// for read and REGISTRATIONS_DELETE for delete. Same handlers also power
// the `registrations_list` and `registrations_delete` MCP tools.
admin.get(
  '/registrations',
  requirePermission(PERMISSIONS.REGISTRATIONS_LIST),
  async (c) => {
    const registrations = await listRegistrationsHandler();
    return c.json(registrations);
  },
);

admin.delete(
  '/registrations/:email',
  requirePermission(PERMISSIONS.REGISTRATIONS_DELETE),
  async (c) => {
    const email = decodeURIComponent(c.req.param('email'));
    await deleteRegistrationHandler(email);
    return c.json({ ok: true });
  },
);

// -------- MCP integrations (self-service) --------
//
// Lists / revokes the CURRENT user's own MCP-client connections.
// Gated on MCP_CONNECT — which currently only admins hold, but the
// handler is permission-agnostic.
admin.get(
  '/integrations',
  requirePermission(PERMISSIONS.MCP_CONNECT),
  async (c) => {
    const u = c.get('user');
    const connections = await listConnectionsHandler({ userId: u.id });
    return c.json(connections);
  },
);

admin.delete(
  '/integrations/:tokenId',
  requirePermission(PERMISSIONS.MCP_CONNECT),
  async (c) => {
    const u = c.get('user');
    const tokenId = c.req.param('tokenId');
    try {
      await revokeConnectionHandler({ userId: u.id, tokenId });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof ConnectionNotFoundError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
  },
);

// -------- Stats --------
//
// Simple admin dashboard counts. Permissions for STATS_VIEW.
admin.get(
  '/stats',
  requirePermission(PERMISSIONS.STATS_VIEW),
  async (c) => {
    const { statsSummaryHandler } = await import(
      '../mcp/handlers/stats.js'
    );
    const summary = await statsSummaryHandler();
    return c.json(summary);
  },
);
