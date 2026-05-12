import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  driver: 'aws-data-api',
  dbCredentials: {
    database: process.env.databaseName!,
    resourceArn: process.env.clusterArn!,
    secretArn: process.env.secretArn!,
  },
} satisfies Config;
