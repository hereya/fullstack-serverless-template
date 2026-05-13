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
// `tokenId` from the UI is the accessTokenHash (it's the stable PK on
// the TOKEN# item in DDB). The revoke flow looks up that item, checks
// ownership against the authenticated user, then stamps revokedAt.

import {
  getClient,
  getTokenByAccessHash,
  listTokensByUser,
  revokeToken,
} from '../../auth/oauthStore.js';

export interface ConnectionView {
  tokenId: string;
  clientId: string;
  clientName: string;
  scope: string;
  createdAt: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

export async function listConnectionsHandler(opts: {
  userId: string;
}): Promise<ConnectionView[]> {
  const tokens = await listTokensByUser(opts.userId);
  // Hydrate client names. Client cardinality per user is tiny (one or
  // two MCP apps in practice), so per-row GetItem is fine. A future
  // optimization could batch-get, but it's overkill here.
  const out: ConnectionView[] = [];
  for (const t of tokens) {
    const client = await getClient(t.clientId);
    out.push({
      tokenId: t.tokenId,
      clientId: t.clientId,
      clientName: client?.name ?? t.clientId,
      scope: t.scope,
      createdAt: t.createdAt,
      accessExpiresAt: t.accessExpiresAt,
      refreshExpiresAt: t.refreshExpiresAt,
    });
  }
  return out;
}

export class ConnectionNotFoundError extends Error {
  constructor() {
    super('connection not found');
    this.name = 'ConnectionNotFoundError';
  }
}

// Revoke = stamp revokedAt on the TOKEN# row + delete the REFRESH#
// pointer. revokeToken() in the store does both. The bearer-token
// middleware filters on `revokedAt IS NULL`, so the next MCP call
// returns 401.
//
// Ownership check is server-side here: we re-fetch the token by ID and
// confirm the userId matches. Without this, a user could revoke
// someone else's connection by guessing token hashes.
export async function revokeConnectionHandler(opts: {
  userId: string;
  tokenId: string;
}): Promise<void> {
  const tok = await getTokenByAccessHash(opts.tokenId);
  if (!tok || tok.userId !== opts.userId) {
    throw new ConnectionNotFoundError();
  }
  await revokeToken(opts.tokenId);
}
