// DDB layer for the authRolesTable. Each role item holds the set of
// permissions it grants. The application looks up role.permissions
// (cached via auth/permissions.ts) to decide whether a user may proceed.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

let _doc: DynamoDBDocumentClient | null = null;
function doc(): DynamoDBDocumentClient {
  if (!_doc) {
    _doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      // DDB string sets can be represented as native JS Sets via the
      // document client when this flag is enabled.
      marshallOptions: { convertClassInstanceToMap: true },
    });
  }
  return _doc;
}

function tableName(): string {
  const t = process.env.authRolesTableName;
  if (!t) throw new Error('authRolesTableName env var missing');
  return t;
}

export interface RoleRow {
  roleName: string;
  permissions: Set<string>;
  description?: string;
  createdAt: string;
}

function toRow(item: Record<string, unknown>): RoleRow {
  const raw = item.permissions;
  // Document client returns StringSet as a Set<string> when present; null/
  // undefined/array fallbacks are defensive in case of marshalling quirks.
  let perms: Set<string>;
  if (raw instanceof Set) perms = raw as Set<string>;
  else if (Array.isArray(raw)) perms = new Set(raw as string[]);
  else perms = new Set();
  return {
    roleName: item.roleName as string,
    permissions: perms,
    description: item.description as string | undefined,
    createdAt: item.createdAt as string,
  };
}

export async function getRole(roleName: string): Promise<RoleRow | null> {
  const r = await doc().send(
    new GetCommand({ TableName: tableName(), Key: { roleName } }),
  );
  return r.Item ? toRow(r.Item) : null;
}

export async function listRoles(): Promise<RoleRow[]> {
  const out: RoleRow[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const r = await doc().send(
      new ScanCommand({ TableName: tableName(), ExclusiveStartKey: lastKey }),
    );
    for (const item of r.Items ?? []) out.push(toRow(item));
    lastKey = r.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

// Idempotent seed. Creates the role only if no row with that name exists,
// so an admin's manual edits to a role's permission set are NEVER
// overwritten by a cold-start re-seed.
export async function upsertRoleIfMissing(
  roleName: string,
  permissions: readonly string[],
  description?: string,
): Promise<void> {
  try {
    await doc().send(
      new PutCommand({
        TableName: tableName(),
        Item: {
          roleName,
          permissions: new Set(permissions),
          ...(description ? { description } : {}),
          createdAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(roleName)',
      }),
    );
  } catch (err) {
    const e = err as { name?: string };
    if (e.name === 'ConditionalCheckFailedException') return; // already exists
    throw err;
  }
}

// Force-overwrite of a role's permission set. Used for roles whose semantic
// is "always tracks the current code constants" — namely `admin`, which is
// defined as "has every permission the app currently defines". Adding a new
// permission constant in permissions.ts should grant admins access without
// requiring a separate migration step.
//
// Preserves the createdAt of the existing row if one exists, so the row's
// creation timestamp doesn't drift on every cold start.
export async function upsertRoleOverwrite(
  roleName: string,
  permissions: readonly string[],
  description?: string,
): Promise<void> {
  const existing = await getRole(roleName);
  await doc().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        roleName,
        permissions: new Set(permissions),
        ...(description ? { description } : {}),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      },
    }),
  );
}

export async function updateRolePermissions(
  roleName: string,
  permissions: readonly string[],
): Promise<void> {
  await doc().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { roleName },
      UpdateExpression: 'SET permissions = :p',
      ExpressionAttributeValues: { ':p': new Set(permissions) },
      ConditionExpression: 'attribute_exists(roleName)',
    }),
  );
}
