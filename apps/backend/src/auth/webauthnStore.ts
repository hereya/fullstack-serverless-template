// DDB-backed store for WebAuthn (passkey) state. Lives on the SAME
// physical table as oauthStore (`hereya/aws-ddb-app-state`, env var
// oauthStateTableName) — see oauthStore.ts for the single-table
// discriminator pattern.
//
// Two new discriminators on top of OAuth's CLIENT#/CODE#/TOKEN#/REFRESH#:
//
//   WACRED#<credentialIdB64Url>   — durable. A registered passkey.
//                                   Carries userId + createdAt so it
//                                   appears in the existing byUser-index
//                                   GSI (for listing/management).
//   WACHAL#<challengeIdB64Url>    — short-lived (5 min). An in-flight
//                                   registration or authentication
//                                   challenge. Single-use; DeleteCommand
//                                   on consume.
//
// WACRED# items deliberately match the byUser-index key schema (userId
// PK, createdAt SK) so we don't need a new GSI. listTokensByUser() in
// oauthStore.ts filters by `refreshExpiresAt > now`, which WACRED# items
// lack — so they're naturally excluded from that listing.
// listCredentialsByUser() below does the inverse via begins_with(pk,
// "WACRED#").

import crypto from 'node:crypto';
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

const CHALLENGE_TTL_SECONDS = 5 * 60;

// ============================================================================
// CHALLENGE — short-lived registration/authentication challenges (5 min, single-use)
// ============================================================================

export type ChallengeKind = 'register' | 'auth';

export interface ChallengeRow {
  challenge: string;
  kind: ChallengeKind;
  userId: string | null;
  email: string | null;
}

export async function createChallenge(opts: {
  kind: ChallengeKind;
  challenge: string;
  userId?: string | null;
  email?: string | null;
}): Promise<{ challengeId: string }> {
  const challengeId = crypto.randomBytes(24).toString('base64url');
  // OMIT userId / email when null instead of writing null values. The
  // shared aws-ddb-app-state table's byUser-index expects userId to be
  // a string; writing the literal NULL type raises a ValidationException
  // ("Type mismatch for Index Key userId"). Sparse-index semantics: rows
  // without a userId attribute simply don't appear in the GSI, which is
  // exactly what we want for auth-kind challenges.
  const item: Record<string, unknown> = {
    pk: `WACHAL#${challengeId}`,
    challengeId,
    challenge: opts.challenge,
    kind: opts.kind,
    createdAt: new Date().toISOString(),
    ttl: nowSeconds() + CHALLENGE_TTL_SECONDS,
  };
  if (opts.userId) item.userId = opts.userId;
  if (opts.email) item.email = opts.email;
  await doc().send(
    new PutCommand({
      TableName: tableName(),
      Item: item,
    }),
  );
  return { challengeId };
}

/**
 * Atomic single-use consume. Returns the challenge row if we hold the
 * consumption; null if missing, expired, already consumed, or kind
 * mismatch. The DeleteCommand returns the row's old attributes so we
 * can inspect kind/userId/etc. in one round trip.
 */
export async function consumeChallenge(
  challengeId: string,
  expectedKind: ChallengeKind,
): Promise<ChallengeRow | null> {
  try {
    const r = await doc().send(
      new DeleteCommand({
        TableName: tableName(),
        Key: { pk: `WACHAL#${challengeId}` },
        ConditionExpression: 'attribute_exists(pk)',
        ReturnValues: 'ALL_OLD',
      }),
    );
    const item = r.Attributes;
    if (!item) return null;
    if (item.kind !== expectedKind) return null;
    if (typeof item.ttl === 'number' && item.ttl < nowSeconds()) return null;
    return {
      challenge: item.challenge as string,
      kind: item.kind as ChallengeKind,
      userId: (item.userId as string | null) ?? null,
      email: (item.email as string | null) ?? null,
    };
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'name' in err &&
      (err as { name: string }).name === 'ConditionalCheckFailedException'
    ) {
      return null;
    }
    throw err;
  }
}

// ============================================================================
// CREDENTIAL — registered passkeys (durable)
// ============================================================================

export interface WebAuthnCredential {
  credentialId: string;        // base64url
  userId: string;              // local user id (UUID)
  publicKey: string;           // base64url-encoded COSE key bytes
  counter: number;             // signature counter
  transports: string[];        // hint from the authenticator
  deviceLabel: string;         // user-supplied
  createdAt: string;           // ISO
  lastUsedAt: string | null;   // ISO
}

function toCredential(item: Record<string, unknown>): WebAuthnCredential {
  return {
    credentialId: item.credentialId as string,
    userId: item.userId as string,
    publicKey: item.publicKey as string,
    counter: typeof item.counter === 'number' ? item.counter : 0,
    transports: Array.isArray(item.transports) ? (item.transports as string[]) : [],
    deviceLabel: (item.deviceLabel as string) ?? '',
    createdAt: item.createdAt as string,
    lastUsedAt: (item.lastUsedAt as string | null) ?? null,
  };
}

export async function registerCredential(c: {
  credentialId: string;
  userId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceLabel: string;
}): Promise<void> {
  await doc().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        pk: `WACRED#${c.credentialId}`,
        credentialId: c.credentialId,
        userId: c.userId,
        publicKey: c.publicKey,
        counter: c.counter,
        transports: c.transports,
        deviceLabel: c.deviceLabel,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
}

export async function getCredential(
  credentialId: string,
): Promise<WebAuthnCredential | null> {
  const r = await doc().send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: `WACRED#${credentialId}` },
    }),
  );
  if (!r.Item) return null;
  return toCredential(r.Item);
}

export async function listCredentialsByUser(
  userId: string,
): Promise<WebAuthnCredential[]> {
  const r = await doc().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: 'byUser-index',
      KeyConditionExpression: 'userId = :u',
      FilterExpression: 'begins_with(pk, :p)',
      ExpressionAttributeValues: { ':u': userId, ':p': 'WACRED#' },
      ScanIndexForward: false, // newest first
    }),
  );
  const items = (r.Items ?? []) as Record<string, unknown>[];
  return items.map(toCredential);
}

export async function updateCredentialCounter(
  credentialId: string,
  newCounter: number,
): Promise<void> {
  await doc().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { pk: `WACRED#${credentialId}` },
      UpdateExpression: 'SET #c = :c, lastUsedAt = :now',
      ExpressionAttributeNames: { '#c': 'counter' },
      ExpressionAttributeValues: {
        ':c': newCounter,
        ':now': new Date().toISOString(),
      },
    }),
  );
}

/**
 * Owner-scoped delete. Returns true on success, false if the row didn't
 * exist or belongs to a different user (ConditionalCheckFailed).
 */
export async function revokeCredential(
  credentialId: string,
  userId: string,
): Promise<boolean> {
  try {
    await doc().send(
      new DeleteCommand({
        TableName: tableName(),
        Key: { pk: `WACRED#${credentialId}` },
        ConditionExpression: 'attribute_exists(pk) AND userId = :u',
        ExpressionAttributeValues: { ':u': userId },
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
