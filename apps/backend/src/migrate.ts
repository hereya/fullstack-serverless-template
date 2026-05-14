// No-op migration Lambda. The hereya/aws-app-lambda CDK wires this
// Lambda to a CloudFormation Custom Resource that fires on every stack
// create/update. The minimal template has no migrations to run, so
// this handler returns success immediately and does no work.
//
// When a feature needs to migrate or backfill data on deploy, see
// [docs/patterns/migrations.md](../../../docs/patterns/migrations.md)
// — that pattern wires a `MIGRATIONS` array + a `hasRun`/`markRun`
// sentinel so each entry runs exactly once across the fleet. Replace
// this handler with the body from that doc.
//
// (Drizzle schema migrations are a different flow — see
// [docs/patterns/notes.md](../../../docs/patterns/notes.md) which
// re-wires this file to invoke `runMigrations()` from `db/migrator.ts`.)
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
