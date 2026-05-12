// Admin HTTP surface. Every route here is a thin adapter over a
// shared handler in src/mcp/handlers/ — the same handler is also
// invoked from the matching MCP tool in src/mcp/tools/. The two
// surfaces are gated on the SAME permission constant, so they stay
// in lockstep on both behavior and authorization.
//
// Convention reminder: when you add a new admin route here, you MUST
// also add the matching MCP tool. See docs/adding-features.md.

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
import { listSubscriptionsHandler } from '../mcp/handlers/subscriptions.js';
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

// -------- Newsletter subscriptions (admin read-only) --------
//
// Lists rows from the public `newsletter_subscriptions` Postgres table
// so admins can see who has subscribed via the /subscribe page. Gated
// by the newsletter:list permission (admin role gets it via
// ALL_PERMISSIONS). Same handler also powers the `subscriptions_list`
// MCP tool.
admin.get(
  '/subscriptions',
  requirePermission(PERMISSIONS.NEWSLETTER_LIST),
  async (c) => {
    const subscriptions = await listSubscriptionsHandler();
    return c.json(subscriptions);
  },
);

// -------- MCP integrations (self-service) --------
//
// Lists / revokes the CURRENT user's own MCP-client connections.
// Gated on MCP_CONNECT — which currently only admins hold, but the
// handler is permission-agnostic. If you ever grant MCP_CONNECT to a
// non-admin role, the route + page just work for them too.
//
// No matching MCP tool: a connection-management surface accessed
// FROM the connection itself is weird (a token revoking itself
// mid-call), and an admin-revoke-someone-else tool would need a
// separate permission. Keep it HTTP-only for now.
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
