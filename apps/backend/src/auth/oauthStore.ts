// DDB-backed store for OAuth 2.1 / MCP machinery state. Replaces the
// Drizzle-on-Aurora oauth_clients / oauth_auth_codes / oauth_tokens
// tables — moving to DDB removes Aurora cold-start latency from the
// MCP token-resolution hot path (every authed /mcp call previously had
// to wake Aurora to look up the bearer token).
//
// The single underlying table is provisioned by hereya/aws-ddb-app-state.
// Single-table design within OAuth — discriminator prefix on the
// partition key keeps four entity kinds in one physical table:
//
//   CLIENT#<clientId>          — DCR-registered client metadata
//   CODE#<authCode>            — auth code, 60s lifetime, single-use
//   TOKEN#<accessTokenHash>    — full token row
//   REFRESH#<refreshTokenHash> — small pointer item -> accessTokenHash
//
// DDB native TTL on the `ttl` attribute prunes expired rows asynchronously
// (~48h grace). Validity windows (60s codes, 24h access, 30d refresh)
// are also filtered at read time — the app never trusts unexpired rows
// to actually still be there.
//
// byUser-index (PK userId, SK createdAt) is sparse — only TOKEN# items
// set userId/createdAt, so a Query against it returns just that user's
// active token connections without filtering CLIENT/CODE/REFRESH out.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

let _doc: DynamoDBDocumentClient | null = null;
function doc(): DynamoDBDocumentClient {
  if (!_doc) _doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return _doc;
}

function tableName(): string {
  const t = process.env.oauthStateTableName;
  if (!t) throw new Error('oauthStateTableName env var missing');
  return t;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ============================================================================
// CLIENT — DCR-registered MCP clients
// ============================================================================

export interface OAuthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  logoUri?: string;
  clientUri?: string;
  createdAt: string;
}

export async function createClient(c: OAuthClient): Promise<void> {
  await doc().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        pk: `CLIENT#${c.clientId}`,
        clientId: c.clientId,
        name: c.name,
        redirectUris: c.redirectUris,
        logoUri: c.logoUri,
        clientUri: c.clientUri,
        createdAt: c.createdAt,
      },
    }),
  );
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  const r = await doc().send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: `CLIENT#${clientId}` },
    }),
  );
  if (!r.Item) return null;
  return {
    clientId: r.Item.clientId,
    name: r.Item.name,
    redirectUris: r.Item.redirectUris as string[],
    logoUri: r.Item.logoUri,
    clientUri: r.Item.clientUri,
    createdAt: r.Item.createdAt,
  };
}

// ============================================================================
// CODE — short-lived authorization codes (60s, single-use)
// ============================================================================

export interface OAuthCode {
  code: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  expiresAt: number; // Unix seconds
}

export async function createCode(c: OAuthCode): Promise<void> {
  await doc().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        pk: `CODE#${c.code}`,
        code: c.code,
        clientId: c.clientId,
        userId: c.userId,
        redirectUri: c.redirectUri,
        codeChallenge: c.codeChallenge,
        codeChallengeMethod: c.codeChallengeMethod,
        scope: c.scope,
        expiresAt: c.expiresAt,
        ttl: c.expiresAt, // DDB native TTL
      },
    }),
  );
}

/**
 * Look up a code without consuming it. Returns null if missing or
 * naturally expired. Callers MUST also call consumeCode() once they've
 * verified PKCE — single-use semantics.
 */
export async function getCode(code: string): Promise<OAuthCode | null> {
  const r = await doc().send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: `CODE#${code}` },
    }),
  );
  if (!r.Item) return null;
  if (typeof r.Item.expiresAt === 'number' && r.Item.expiresAt < nowSeconds()) {
    return null;
  }
  return {
    code: r.Item.code,
    clientId: r.Item.clientId,
    userId: r.Item.userId,
    redirectUri: r.Item.redirectUri,
    codeChallenge: r.Item.codeChallenge,
    codeChallengeMethod: r.Item.codeChallengeMethod,
    scope: r.Item.scope,
    expiresAt: r.Item.expiresAt,
  };
}

/**
 * Atomic single-use consume: deletes the row only if it still exists.
 * Returns true if we won the race (we hold the consumption); false if
 * someone else got there first (replay or concurrent exchange).
 */
export async function consumeCode(code: string): Promise<boolean> {
  try {
    await doc().send(
      new DeleteCommand({
        TableName: tableName(),
        Key: { pk: `CODE#${code}` },
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
    return true;
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'name' in err &&
      (err as { name: string }).name === 'ConditionalCheckFailedException'
    ) {
      return false;
    }
    throw err;
  }
}

// ============================================================================
// TOKEN — active access + refresh tokens. Each token is two items:
//   1. The canonical TOKEN# row (carries all attributes)
//   2. A REFRESH# pointer item (small; maps refresh-hash -> access-hash)
// ============================================================================

export interface OAuthToken {
  tokenId: string; // same as accessTokenHash — kept as a stable id for the admin UI
  accessTokenHash: string;
  refreshTokenHash: string;
  clientId: string;
  userId: string;
  scope: string;
  accessExpiresAt: number; // Unix seconds
  refreshExpiresAt: number;
  revokedAt: string | null;
  createdAt: string;
}

export async function createToken(t: {
  accessTokenHash: string;
  refreshTokenHash: string;
  clientId: string;
  userId: string;
  scope: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}): Promise<void> {
  const createdAt = new Date().toISOString();
  // TOKEN row — the source of truth for the bearer middleware. byUser-
  // index picks this up because it sets userId + createdAt.
  await doc().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        pk: `TOKEN#${t.accessTokenHash}`,
        tokenId: t.accessTokenHash,
        accessTokenHash: t.accessTokenHash,
        refreshTokenHash: t.refreshTokenHash,
        clientId: t.clientId,
        userId: t.userId,
        scope: t.scope,
        accessExpiresAt: t.accessExpiresAt,
        refreshExpiresAt: t.refreshExpiresAt,
        revokedAt: null,
        createdAt,
        ttl: t.refreshExpiresAt, // refresh window outlives access
      },
    }),
  );
  // REFRESH# pointer — only needed for the refresh-grant flow. Kept
  // minimal so the byUser-index doesn't double-count tokens (no userId
  // attribute → not in the sparse GSI).
  await doc().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        pk: `REFRESH#${t.refreshTokenHash}`,
        accessTokenHash: t.accessTokenHash,
        clientId: t.clientId,
        ttl: t.refreshExpiresAt,
      },
    }),
  );
}

function mapTokenRow(item: Record<string, unknown>): OAuthToken {
  return {
    tokenId: item.accessTokenHash as string,
    accessTokenHash: item.accessTokenHash as string,
    refreshTokenHash: item.refreshTokenHash as string,
    clientId: item.clientId as string,
    userId: item.userId as string,
    scope: item.scope as string,
    accessExpiresAt: item.accessExpiresAt as number,
    refreshExpiresAt: item.refreshExpiresAt as number,
    revokedAt: (item.revokedAt as string | null) ?? null,
    createdAt: item.createdAt as string,
  };
}

/**
 * Bearer-middleware lookup. Returns null if missing, revoked, or the
 * access window has elapsed. Refresh expiry isn't relevant here.
 */
export async function getTokenByAccessHash(
  accessTokenHash: string,
): Promise<OAuthToken | null> {
  const r = await doc().send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: `TOKEN#${accessTokenHash}` },
    }),
  );
  if (!r.Item) return null;
  if (r.Item.revokedAt) return null;
  if (
    typeof r.Item.accessExpiresAt === 'number' &&
    r.Item.accessExpiresAt < nowSeconds()
  ) {
    return null;
  }
  return mapTokenRow(r.Item);
}

/**
 * Refresh-grant lookup. Two-step: REFRESH# pointer -> TOKEN# row.
 * Returns null if either step misses, the token is revoked, or the
 * refresh window has elapsed.
 */
export async function getTokenByRefreshHash(
  refreshTokenHash: string,
): Promise<OAuthToken | null> {
  const ptr = await doc().send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: `REFRESH#${refreshTokenHash}` },
    }),
  );
  if (!ptr.Item) return null;
  const access = ptr.Item.accessTokenHash as string;
  const tok = await doc().send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: `TOKEN#${access}` },
    }),
  );
  if (!tok.Item) return null;
  if (tok.Item.revokedAt) return null;
  if (
    typeof tok.Item.refreshExpiresAt === 'number' &&
    tok.Item.refreshExpiresAt < nowSeconds()
  ) {
    return null;
  }
  return mapTokenRow(tok.Item);
}

/**
 * Soft-revoke. Stamps revokedAt on the TOKEN# row AND deletes the
 * REFRESH# pointer so the refresh hash can never be reused (defence
 * against refresh-token theft replays). The bearer middleware
 * separately filters revokedAt so the access token also stops working
 * within the next request — no 24h delay.
 */
export async function revokeToken(accessTokenHash: string): Promise<void> {
  // First fetch the row to grab the refresh hash — we need it to delete
  // the pointer item.
  const r = await doc().send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: `TOKEN#${accessTokenHash}` },
    }),
  );
  if (!r.Item) return;
  await doc().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { pk: `TOKEN#${accessTokenHash}` },
      UpdateExpression: 'SET revokedAt = :now',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }),
  );
  if (typeof r.Item.refreshTokenHash === 'string') {
    try {
      await doc().send(
        new DeleteCommand({
          TableName: tableName(),
          Key: { pk: `REFRESH#${r.Item.refreshTokenHash}` },
        }),
      );
    } catch {
      // best-effort; if the pointer is already gone we don't care.
    }
  }
}

/**
 * Admin /integrations listing: every active (non-revoked, non-expired)
 * token row for a given user, newest first. Drives the page that lets
 * a user see + revoke their AI-agent connections.
 */
export async function listTokensByUser(userId: string): Promise<OAuthToken[]> {
  const r = await doc().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: 'byUser-index',
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': userId },
      ScanIndexForward: false, // newest first
    }),
  );
  const items = (r.Items ?? []) as Record<string, unknown>[];
  const now = nowSeconds();
  return items
    .filter(
      (i) =>
        !i.revokedAt &&
        typeof i.refreshExpiresAt === 'number' &&
        (i.refreshExpiresAt as number) > now,
    )
    .map(mapTokenRow);
}
