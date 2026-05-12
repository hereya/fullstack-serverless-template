import path from 'node:path';
import { migrate } from 'drizzle-orm/aws-data-api/pg/migrator';
import { getDb } from './client.js';
import { warmupCluster, withRetry } from './resilience.js';

// Resolves the directory containing the generated drizzle SQL files.
// - In Lambda: the asset is unpacked into /var/task, so cwd is /var/task
//   and migrations land at /var/task/drizzle (copied there by the build step).
// - In tsx dev (run from apps/backend/): cwd is apps/backend, drizzle/ is sibling.
// - In scripts/migrate.ts from the monorepo root: that script chdirs into
//   apps/backend before calling runMigrations(), so the same default applies.
// Override via MIGRATIONS_FOLDER env if you need to point elsewhere.
function migrationsFolder(): string {
  return process.env.MIGRATIONS_FOLDER ?? path.resolve(process.cwd(), 'drizzle');
}

export async function runMigrations(): Promise<void> {
  await warmupCluster();
  await withRetry(
    () => migrate(getDb(), { migrationsFolder: migrationsFolder() }),
    { label: 'drizzle migrate', maxAttempts: 6, baseMs: 2000, capMs: 15000 },
  );
}
