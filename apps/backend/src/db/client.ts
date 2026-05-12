import { drizzle } from 'drizzle-orm/aws-data-api/pg';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import * as schema from './schema.js';

let _db: ReturnType<typeof makeDb> | null = null;

function makeDb() {
  const rds = new RDSDataClient({ region: process.env.AWS_REGION });
  return drizzle(rds, {
    database: process.env.databaseName!,
    resourceArn: process.env.clusterArn!,
    secretArn: process.env.secretArn!,
    schema,
  });
}

export function getDb(): ReturnType<typeof makeDb> {
  if (!_db) _db = makeDb();
  return _db;
}
