#!/usr/bin/env tsx
//
// Wipes all dev data so the next sign-in is a fresh first-user-admin bootstrap.
//
//   • Aurora (via Data API): TRUNCATE users, notes, newsletter_subscriptions
//     with CASCADE + RESTART IDENTITY. The __drizzle_migrations tracking table
//     is left intact so migrations are not re-run.
//   • DynamoDB (sessionsTableName): Scan + BatchWrite delete every item.
//
// Tables that don't exist yet (e.g. newsletter_subscriptions before the new
// migration is applied) are tolerated silently.
//
// Usage: hereya run -- npm run db:reset

import {
  RDSDataClient,
  ExecuteStatementCommand,
} from '@aws-sdk/client-rds-data';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';

// Bridge camelCase hereya env → AWS_REGION the SDK expects.
process.env.AWS_REGION ||=
  process.env.awsRegion ?? process.env.awsCognitoRegion;

const REQUIRED = [
  'clusterArn',
  'secretArn',
  'databaseName',
  'sessionsTableName',
  'AWS_REGION',
];
for (const k of REQUIRED) {
  if (!process.env[k]) {
    console.error(
      `Missing env var "${k}". Run as: hereya run -- npm run db:reset`,
    );
    process.exit(2);
  }
}

const REGION = process.env.AWS_REGION!;
const CLUSTER_ARN = process.env.clusterArn!;
const SECRET_ARN = process.env.secretArn!;
const DATABASE = process.env.databaseName!;
const SESSIONS_TABLE = process.env.sessionsTableName!;

const rds = new RDSDataClient({ region: REGION });

async function execSql(
  sql: string,
  opts: { tolerateMissing?: boolean } = {},
): Promise<void> {
  try {
    await rds.send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE,
        sql,
      }),
    );
    console.log(`  ✓ ${sql}`);
  } catch (err) {
    const e = err as { name?: string; message?: string };
    const looksMissing =
      /does not exist|undefined_table|42P01/i.test(e.message ?? '') ||
      e.name === 'BadRequestException';
    if (opts.tolerateMissing && looksMissing) {
      console.log(`  ⊘ ${sql} — table not present yet, skipping`);
      return;
    }
    throw err;
  }
}

async function warmup(): Promise<void> {
  // Aurora Serverless v2 may be paused. Issue a cheap SELECT 1 with retry so
  // the actual truncates don't fail on DatabaseResumingException.
  const maxAttempts = 12;
  const baseMs = 2000;
  const capMs = 15000;
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      await rds.send(
        new ExecuteStatementCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: SECRET_ARN,
          database: DATABASE,
          sql: 'SELECT 1',
        }),
      );
      return;
    } catch (err) {
      const e = err as { name?: string; message?: string };
      const transient =
        e.name === 'DatabaseResumingException' ||
        /currently resuming|currently scaling|is paused/i.test(e.message ?? '');
      if (!transient) throw err;
      attempt += 1;
      if (attempt >= maxAttempts) throw err;
      const delay = Math.min(capMs, baseMs * 2 ** (attempt - 1));
      console.log(
        `  ↻ warmup: cluster ${e.name ?? 'transient'}, retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function clearAurora(): Promise<void> {
  console.log(`\nClearing Aurora data in "${DATABASE}" (${REGION})...`);
  await warmup();
  // CASCADE handles `notes.user_id` FK to users.
  await execSql('TRUNCATE users RESTART IDENTITY CASCADE', {
    tolerateMissing: true,
  });
  await execSql('TRUNCATE notes RESTART IDENTITY CASCADE', {
    tolerateMissing: true,
  });
  await execSql('TRUNCATE newsletter_subscriptions RESTART IDENTITY CASCADE', {
    tolerateMissing: true,
  });
}

async function clearSessions(): Promise<void> {
  console.log(`\nClearing DynamoDB sessions ("${SESSIONS_TABLE}")...`);
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let total = 0;
  try {
    do {
      const result: {
        Items?: Array<{ sessionId: string }>;
        LastEvaluatedKey?: Record<string, unknown>;
      } = await ddb.send(
        new ScanCommand({
          TableName: SESSIONS_TABLE,
          ProjectionExpression: 'sessionId',
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      const items = result.Items ?? [];
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25).map((item) => ({
          DeleteRequest: { Key: { sessionId: item.sessionId } },
        }));
        await ddb.send(
          new BatchWriteCommand({ RequestItems: { [SESSIONS_TABLE]: batch } }),
        );
      }
      total += items.length;
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    console.log(`  ✓ deleted ${total} session item(s)`);
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e.name === 'AccessDeniedException' && /Scan/i.test(e.message ?? '')) {
      console.log(
        '  ⊘ dev IAM user lacks dynamodb:Scan permission — leaving sessions in place.',
      );
      console.log(
        '    Stale sessions clear themselves on next request: authMiddleware',
      );
      console.log(
        '    will see findUserById() return null (users table is empty), then',
      );
      console.log('    delete the DDB row + cookie.');
      return;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  console.log('Hereya dev DB reset');
  console.log('===================');
  await clearAurora();
  await clearSessions();
  console.log('\nDone. The next /api/auth/request-otp on an empty users table');
  console.log('will create the first-user-admin row on successful OTP verification.');
}

main().catch((err) => {
  console.error('\n❌ Reset failed:', err);
  process.exit(1);
});
