// DDB-backed store for public-form registrations. Replaces the Drizzle-on-
// Aurora `newsletter_subscriptions` table that used to live here — moving
// to DDB removes Aurora cold-start latency from the public form post path.
//
// The table is provisioned by hereya/aws-ddb-app-state. Each row is a
// single item keyed by email; extra fields beyond email + createdAt are
// optional (the table is schema-less, so projects can capture name /
// referrer / custom fields without code changes here — see the
// "richer-registration" pattern doc).
//
// Idempotent writes: re-submitting the same email is a no-op (using
// `attribute_not_exists` on PutItem so the first row wins). This matches
// the public form's "we don't reveal whether the email was already
// subscribed" stance — the caller never learns the difference.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';

let _doc: DynamoDBDocumentClient | null = null;
function doc(): DynamoDBDocumentClient {
  if (!_doc) _doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return _doc;
}

function tableName(): string {
  const t = process.env.registrationsTableName;
  if (!t) throw new Error('registrationsTableName env var missing');
  return t;
}

export interface Registration {
  email: string;
  createdAt: string;
  // Any extra fields the form captured. Projects extending the form (see
  // the richer-registration pattern) drop their own typed shape here.
  [extra: string]: unknown;
}

/**
 * Idempotent insert. First submission wins; subsequent submissions for the
 * same email return without modifying the existing row. Callers shouldn't
 * surface "already subscribed" to end users (avoids email enumeration on
 * the public form).
 */
export async function addRegistration(
  email: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const item = {
    email,
    createdAt: new Date().toISOString(),
    ...extra,
  };
  try {
    await doc().send(
      new PutCommand({
        TableName: tableName(),
        Item: item,
        ConditionExpression: 'attribute_not_exists(email)',
      }),
    );
  } catch (err) {
    // ConditionalCheckFailedException = already subscribed. Swallow.
    if (
      err &&
      typeof err === 'object' &&
      'name' in err &&
      (err as { name: string }).name === 'ConditionalCheckFailedException'
    ) {
      return;
    }
    throw err;
  }
}

export async function getRegistration(
  email: string,
): Promise<Registration | null> {
  const r = await doc().send(
    new GetCommand({ TableName: tableName(), Key: { email } }),
  );
  if (!r.Item) return null;
  return r.Item as Registration;
}

/**
 * Paginated full-table scan. Cap is high enough that an admin page can
 * render everything for a typical small/medium project; if a project
 * grows past a few thousand registrations, swap this for a paginator
 * (the call sites are localized to the admin handler and MCP tool).
 *
 * Items are sorted client-side by createdAt desc — newest first — so the
 * admin page shows the most recent signups at the top without needing a
 * GSI on createdAt.
 */
export async function listRegistrations(limit = 1000): Promise<Registration[]> {
  const r = await doc().send(
    new ScanCommand({ TableName: tableName(), Limit: limit }),
  );
  const items = (r.Items ?? []) as Registration[];
  return items.sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );
}

export async function removeRegistration(email: string): Promise<void> {
  await doc().send(
    new DeleteCommand({ TableName: tableName(), Key: { email } }),
  );
}

/**
 * Count via Scan with `Select: 'COUNT'` — DDB returns only the count,
 * no row payloads, so this is cheap even for thousands of registrations.
 * Used by the stats endpoint.
 */
export async function countRegistrations(): Promise<number> {
  const r = await doc().send(
    new ScanCommand({ TableName: tableName(), Select: 'COUNT' }),
  );
  return r.Count ?? 0;
}
