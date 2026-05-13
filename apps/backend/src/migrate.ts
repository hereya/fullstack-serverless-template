// No-op migration Lambda. The hereya/aws-app-lambda CDK wires this
// Lambda to a CloudFormation Custom Resource that fires on every stack
// create/update. The minimal template has no Aurora schema to migrate
// (Drizzle is gone — see CLAUDE.md's "Data layer rule of thumb"), so
// this handler returns success immediately and does no work.
//
// When a project adopts the notes pattern (docs/patterns/notes.md),
// this file is replaced with the real migration runner:
//
//   import { resolveSecrets } from './secrets.js';
//   import { runMigrations } from './db/migrator.js';
//   const ready = resolveSecrets();
//   // ...await ready; await runMigrations(); ...
//
// Keeping the entrypoint here (rather than deleting it from
// esbuild.config.mjs) preserves compatibility with the
// aws-app-lambda package's expectation that `dist/migrate.js` exists.

interface CfnCustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
}

interface CfnCustomResourceResponse {
  PhysicalResourceId: string;
  Data?: Record<string, string>;
}

export const handler = async (
  event: CfnCustomResourceEvent,
): Promise<CfnCustomResourceResponse> => {
  const physicalResourceId =
    event.PhysicalResourceId ?? 'hereya-app-migrations';
  // No migrations to run. Return success quickly so the deploy doesn't
  // wait on a Lambda that has nothing to do.
  return {
    PhysicalResourceId: physicalResourceId,
    Data: { migratedAt: new Date().toISOString(), noOp: 'true' },
  };
};
