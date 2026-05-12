// Manage the current user's own MCP connections. Used by:
//   - GET    /api/admin/integrations             (list)
//   - DELETE /api/admin/integrations/:tokenId    (revoke)
//
// Scope is per-user: each user manages only their own tokens. The
// admin-facing UI at /admin/integrations is gated on the MCP_CONNECT
// permission, which currently only the admin role holds — but the
// handler is permission-agnostic and works for any future role that
// can authorize MCP clients.
//
// "Connection" = one OAuth token-pair plus its client metadata. We
// don't track last-used today; adding it means a write on every /mcp
// call, which we punt on as a future enhancement.

import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { dbCall } from '../../db/resilience.js';
import { oauthClients, oauthTokens } from '../../db/schema.js';

export interface ConnectionView {
  tokenId: string;
  clientId: string;
  clientName: string;
  scope: string;
  createdAt: Date | string;
  accessExpiresAt: Date | string;
  refreshExpiresAt: Date | string;
}

export async function listConnectionsHandler(opts: {
  userId: string;
}): Promise<ConnectionView[]> {
  const rows = await dbCall(
    () =>
      getDb()
        .select({
          tokenId: oauthTokens.id,
          clientId: oauthClients.id,
          clientName: oauthClients.name,
          scope: oauthTokens.scope,
          createdAt: oauthTokens.createdAt,
          accessExpiresAt: oauthTokens.accessExpiresAt,
          refreshExpiresAt: oauthTokens.refreshExpiresAt,
        })
        .from(oauthTokens)
        .innerJoin(oauthClients, eq(oauthClients.id, oauthTokens.clientId))
        .where(
          and(
            eq(oauthTokens.userId, opts.userId),
            isNull(oauthTokens.revokedAt),
          ),
        )
        .orderBy(desc(oauthTokens.createdAt)),
    'integrations.list',
  );
  return rows;
}

export class ConnectionNotFoundError extends Error {
  constructor() {
    super('connection not found');
    this.name = 'ConnectionNotFoundError';
  }
}

// Revoke = stamp revokedAt. The bearer-token middleware filters on
// `revokedAt IS NULL`, so the next MCP call from this token returns
// 401. We do not delete the row so the audit trail survives.
export async function revokeConnectionHandler(opts: {
  userId: string;
  tokenId: string;
}): Promise<void> {
  // Double-check ownership BEFORE the update — a user can't revoke
  // someone else's connection by guessing UUIDs.
  const rows = await dbCall(
    () =>
      getDb()
        .select({ id: oauthTokens.id })
        .from(oauthTokens)
        .where(
          and(
            eq(oauthTokens.id, opts.tokenId),
            eq(oauthTokens.userId, opts.userId),
            isNull(oauthTokens.revokedAt),
          ),
        )
        .limit(1),
    'integrations.revoke.check',
  );
  if (rows.length === 0) throw new ConnectionNotFoundError();
  await dbCall(
    () =>
      getDb()
        .update(oauthTokens)
        .set({ revokedAt: new Date() })
        .where(eq(oauthTokens.id, opts.tokenId)),
    'integrations.revoke',
  );
}
