import crypto from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
  QueryCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';

let _doc: DynamoDBDocumentClient | null = null;
function doc(): DynamoDBDocumentClient {
  if (!_doc) _doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return _doc;
}

const SESSION_TTL_SECONDS = 30 * 24 * 3600; // 30 days

// The session row is a SNAPSHOT of the user's identity + authorization state
// at the moment of login. authMiddleware reads `roleName` from here on every
// authenticated request, so authz checks never need to wake Aurora — and
// the user record itself lives in DDB (authUsersTable), so Aurora is fully
// off the auth path.
//
// Invariants:
//   • Suspending a user MUST call deleteUserSessions(userId) so the
//     suspension takes effect immediately (suspended users have zero session
//     rows and authMiddleware never resolves them past the GetCommand).
//   • Changing a user's roleName MUST call deleteUserSessions(userId) so
//     they re-login and pick up the new role.
//   • Changing a role's permission set (in authRolesTable) DOES NOT require
//     session invalidation — the permission lookup re-reads the role
//     (cached for ~60s in auth/permissions.ts), and that cache observes
//     mutations within its TTL on every Lambda instance.
export interface Session {
  sessionId: string;
  userId: string;
  email: string;
  roleName: string;
  refreshToken: string;
  // Unix seconds — when the DDB TTL will reap this row. Fixed at
  // createSession time (now + 30 days); not extended on use. The client
  // caches this so it can decide "the session has naturally expired"
  // synchronously without hitting /me.
  ttl: number;
}

function tableName(): string {
  const t = process.env.sessionsTableName;
  if (!t) throw new Error('sessionsTableName env var missing');
  return t;
}

export async function createSession(
  userId: string,
  email: string,
  roleName: string,
  refreshToken: string,
): Promise<string> {
  const sessionId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await doc().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        sessionId,
        userId,
        email,
        roleName,
        refreshToken,
        createdAt: new Date().toISOString(),
        ttl: now + SESSION_TTL_SECONDS,
      },
    }),
  );
  return sessionId;
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const r = await doc().send(new GetCommand({ TableName: tableName(), Key: { sessionId } }));
  if (!r.Item) return null;
  return {
    sessionId,
    userId: r.Item.userId,
    email: r.Item.email,
    roleName: (r.Item.roleName as string) ?? 'member',
    refreshToken: r.Item.refreshToken,
    // `ttl` is required on new rows but old rows written before this
    // field existed won't have it — fall back to 0 (which the client
    // interprets as "already expired" → treat as anon → re-auth).
    ttl: typeof r.Item.ttl === 'number' ? r.Item.ttl : 0,
  };
}

export async function deleteSession(sessionId: string): Promise<void> {
  await doc().send(new DeleteCommand({ TableName: tableName(), Key: { sessionId } }));
}

export async function deleteUserSessions(userId: string): Promise<void> {
  const result = await doc().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ProjectionExpression: 'sessionId',
    }),
  );
  if (!result.Items?.length) return;
  for (let i = 0; i < result.Items.length; i += 25) {
    const batch = result.Items.slice(i, i + 25).map((item) => ({
      DeleteRequest: { Key: { sessionId: item.sessionId } },
    }));
    await doc().send(new BatchWriteCommand({ RequestItems: { [tableName()]: batch } }));
  }
}
