#!/usr/bin/env tsx
//
// Drops every Postgres table this app knows about, so the next db:generate +
// db:migrate run can start from a clean baseline. Safe to call at any time
// AGAINST DEV ONLY — never deploy this to prod.
//
// Uses DROP TABLE IF EXISTS, so the script is idempotent and tolerant of
// partial states (some tables present, others not).
//
// Tables targeted:
//   - notes
//   - users                      (legacy, from the discarded Postgres-authz attempt)
//   - newsletter_subscriptions
//   - __drizzle_migrations       (the tracking table — dropping this lets
//                                  the next db:migrate apply the new
//                                  baseline migration from scratch)
//
// Usage: hereya run -- npm run db:drop-all

import {
  RDSDataClient,
  ExecuteStatementCommand,
} from '@aws-sdk/client-rds-data';

process.env.AWS_REGION ||=
  process.env.awsRegion ?? process.env.awsCognitoRegion;

const REQUIRED = ['clusterArn', 'secretArn', 'databaseName', 'AWS_REGION'];
for (const k of REQUIRED) {
  if (!process.env[k]) {
    console.error(
      `Missing env var "${k}". Run as: hereya run -- npm run db:drop-all`,
    );
    process.exit(2);
  }
}

const rds = new RDSDataClient({ region: process.env.AWS_REGION });

async function execSql(sql: string): Promise<void> {
  await rds.send(
    new ExecuteStatementCommand({
      resourceArn: process.env.clusterArn,
      secretArn: process.env.secretArn,
      database: process.env.databaseName,
      sql,
    }),
  );
  console.log(`  ✓ ${sql}`);
}

// Cluster may be paused; warmup with retry.
async function warmup(): Promise<void> {
  const maxAttempts = 12;
  const baseMs = 2000;
  const capMs = 15000;
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      await rds.send(
        new ExecuteStatementCommand({
          resourceArn: process.env.clusterArn,
          secretArn: process.env.secretArn,
          database: process.env.databaseName,
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
        `  ↻ warmup: ${e.name ?? 'transient'}, retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

const TABLES = [
  'notes',
  'users',
  'newsletter_subscriptions',
  '__drizzle_migrations',
  'drizzle.__drizzle_migrations',
];

async function main() {
  console.log('Hereya dev Postgres DROP ALL');
  console.log('============================');
  console.log(`Database: ${process.env.databaseName} (${process.env.AWS_REGION})`);
  console.log('');
  await warmup();
  for (const table of TABLES) {
    await execSql(`DROP TABLE IF EXISTS "${table.replace(/"/g, '""')}" CASCADE`);
  }
  // Drop the drizzle metadata schema too if the migrator created it as a schema.
  await execSql(`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  console.log('\nDone. Next steps:');
  console.log('  hereya run -- npm run db:generate');
  console.log('  hereya run -- npm run db:migrate');
}

main().catch((err) => {
  console.error('\n❌ Drop-all failed:', err);
  process.exit(1);
});
