// DDB-backed user store. This is the authoritative user record — Postgres
// does NOT have a users table. Cognito is authn-only.
//
// Bootstrap detection (first-user-admin) uses a sentinel item:
//   { userId: '__bootstrap__', completedAt: <iso> }
// First-admin creation writes both the user row and the sentinel in a
// single TransactWriteItems, guarded by `attribute_not_exists` on the
// sentinel. Concurrent first-signup attempts therefore can produce
// AT MOST ONE admin — losers fall through to the closed-signup branch.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import crypto from 'node:crypto';

let _doc: DynamoDBDocumentClient | null = null;
function doc(): DynamoDBDocumentClient {
  if (!_doc) _doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return _doc;
}

function tableName(): string {
  const t = process.env.authUsersTableName;
  if (!t) throw new Error('authUsersTableName env var missing');
  return t;
}

const BOOTSTRAP_KEY = '__bootstrap__';

export interface UserRow {
  id: string;
  email: string;
  cognitoSub: string | null;
  roleName: string;
  suspended: boolean;
  createdAt: string;
}

function toRow(item: Record<string, unknown>): UserRow {
  return {
    id: item.userId as string,
    email: item.email as string,
    cognitoSub: (item.cognitoSub as string | undefined) ?? null,
    roleName: (item.roleName as string) ?? 'member',
    suspended: Boolean(item.suspended),
    createdAt: item.createdAt as string,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function findUserById(id: string): Promise<UserRow | null> {
  if (id === BOOTSTRAP_KEY) return null;
  const r = await doc().send(
    new GetCommand({ TableName: tableName(), Key: { userId: id } }),
  );
  return r.Item ? toRow(r.Item) : null;
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const r = await doc().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: 'email-index',
      KeyConditionExpression: 'email = :e',
      ExpressionAttributeValues: { ':e': email },
      Limit: 1,
    }),
  );
  if (!r.Items || r.Items.length === 0) return null;
  const item = r.Items[0];
  if (!item) return null;
  return toRow(item);
}

export async function bootstrapComplete(): Promise<boolean> {
  const r = await doc().send(
    new GetCommand({ TableName: tableName(), Key: { userId: BOOTSTRAP_KEY } }),
  );
  return Boolean(r.Item);
}

// Convenience for legacy call sites. Now: returns the bootstrap sentinel
// existence rather than a full Scan count.
export async function countUsers(): Promise<number> {
  return (await bootstrapComplete()) ? 1 : 0;
}

export async function listUsers(): Promise<UserRow[]> {
  const out: UserRow[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const r = await doc().send(
      new ScanCommand({
        TableName: tableName(),
        ExclusiveStartKey: lastKey,
        // Skip the sentinel.
        FilterExpression: 'userId <> :b',
        ExpressionAttributeValues: { ':b': BOOTSTRAP_KEY },
      }),
    );
    for (const item of r.Items ?? []) out.push(toRow(item));
    lastKey = r.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

// Uses the byRole-index GSI so we Query just the 'admin' partition instead
// of Scanning the whole users table on every PATCH suspend. Cost is now
// O(admin count), not O(total users).
export async function countActiveAdmins(opts: {
  excludeUserId?: string;
} = {}): Promise<number> {
  let total = 0;
  let lastKey: Record<string, unknown> | undefined;
  const exc = opts.excludeUserId ?? '__never__';
  do {
    const params: QueryCommandInput = {
      TableName: tableName(),
      IndexName: 'byRole-index',
      KeyConditionExpression: 'roleName = :admin',
      FilterExpression:
        'suspended = :no AND attribute_exists(cognitoSub) AND userId <> :exc',
      ExpressionAttributeValues: {
        ':admin': 'admin',
        ':no': false,
        ':exc': exc,
      },
      ExclusiveStartKey: lastKey,
    };
    const r = await doc().send(new QueryCommand(params));
    total += (r.Items ?? []).length;
    lastKey = r.LastEvaluatedKey;
  } while (lastKey);
  return total;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// First-user-admin creation. Writes the user row AND the bootstrap sentinel
// atomically. The condition `attribute_not_exists(userId)` on the sentinel
// ensures that under concurrent first-signup attempts, at most one wins
// (the loser gets ConditionalCheckFailed on the sentinel and the whole
// transaction is aborted — caller can then resolve via the normal allowlist
// path on retry).
export async function createFirstAdmin(
  email: string,
  cognitoSub: string,
): Promise<UserRow> {
  const userId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await doc().send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName(),
            Item: {
              userId,
              email,
              cognitoSub,
              roleName: 'admin',
              suspended: false,
              createdAt,
            },
            ConditionExpression: 'attribute_not_exists(userId)',
          },
        },
        {
          Put: {
            TableName: tableName(),
            Item: {
              userId: BOOTSTRAP_KEY,
              completedAt: createdAt,
            },
            ConditionExpression: 'attribute_not_exists(userId)',
          },
        },
      ],
    }),
  );
  return {
    id: userId,
    email,
    cognitoSub,
    roleName: 'admin',
    suspended: false,
    createdAt,
  };
}

export async function addAllowlistedUser(email: string): Promise<UserRow> {
  // Email-uniqueness via a pre-check on the email-index. Not perfectly
  // race-free (no DDB-side unique constraint across a GSI), but the
  // admin "add user" UI is low-concurrency and a second click would just
  // see "already exists" anyway.
  const existing = await findUserByEmail(email);
  if (existing) {
    const err = new Error(`User with email ${email} already exists`);
    (err as { name?: string }).name = 'UserAlreadyExistsException';
    throw err;
  }
  const userId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await doc().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        userId,
        email,
        roleName: 'member',
        suspended: false,
        createdAt,
        // cognitoSub absent — set on first sign-in
      },
      ConditionExpression: 'attribute_not_exists(userId)',
    }),
  );
  return {
    id: userId,
    email,
    cognitoSub: null,
    roleName: 'member',
    suspended: false,
    createdAt,
  };
}

export async function linkCognitoSub(
  userId: string,
  cognitoSub: string,
): Promise<void> {
  await doc().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { userId },
      UpdateExpression: 'SET cognitoSub = :s',
      // Only set when absent — never overwrite a sub.
      ConditionExpression:
        'attribute_exists(userId) AND attribute_not_exists(cognitoSub)',
      ExpressionAttributeValues: { ':s': cognitoSub },
    }),
  );
}

export async function setSuspended(
  userId: string,
  suspended: boolean,
): Promise<UserRow | null> {
  try {
    const r = await doc().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { userId },
        UpdateExpression: 'SET suspended = :s',
        ConditionExpression: 'attribute_exists(userId)',
        ExpressionAttributeValues: { ':s': suspended },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return r.Attributes ? toRow(r.Attributes) : null;
  } catch (err) {
    const e = err as { name?: string };
    if (e.name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
}
