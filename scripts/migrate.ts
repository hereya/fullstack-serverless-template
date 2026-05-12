#!/usr/bin/env tsx
import { runMigrations } from '../apps/backend/src/db/migrator.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Override migrationsFolder lookup so the script works from the monorepo root.
const here = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.resolve(here, '..', 'apps', 'backend'));

async function main() {
  // Bridge camelCase region → AWS_REGION as the backend env does.
  process.env.AWS_REGION ||= process.env.awsRegion ?? process.env.awsCognitoRegion;
  // eslint-disable-next-line no-console
  console.log('Running migrations against', process.env.databaseName, 'in', process.env.AWS_REGION);
  await runMigrations();
  // eslint-disable-next-line no-console
  console.log('Migrations applied');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
