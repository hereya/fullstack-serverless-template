// Migration Lambda entrypoint — invoked by the CloudFormation Custom Resource
// in `hereya/aws-app-lambda` on every stack create/update so the deployed app
// always runs against an up-to-date schema. The Drizzle migrator is idempotent:
// drizzle tracks applied migrations in `__drizzle_migrations`, so re-runs are
// no-ops when nothing has changed.
import { resolveSecrets } from './secrets.js';
import { runMigrations } from './db/migrator.js';

// CloudFormation Custom Resource event shape (what cr.Provider hands us).
interface CfnCustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  LogicalResourceId?: string;
  RequestId?: string;
  StackId?: string;
  ResourceProperties?: Record<string, unknown>;
  OldResourceProperties?: Record<string, unknown>;
}

interface CfnCustomResourceResponse {
  PhysicalResourceId: string;
  Data?: Record<string, string>;
}

// Resolve secrets once per cold start (HEREYA_SECRETS_ARN, if set).
const ready = resolveSecrets();

export const handler = async (
  event: CfnCustomResourceEvent,
): Promise<CfnCustomResourceResponse> => {
  // Preserve the physical id across update cycles. Default to a stable string
  // on first create so subsequent updates keep the same id (avoiding the
  // "replace" semantics CFn applies when physical ids change).
  const physicalResourceId = event.PhysicalResourceId ?? 'hereya-app-migrations';

  // We keep the database on stack delete. No migration to "undo" — drop the
  // event silently.
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: physicalResourceId };
  }

  await ready;

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      at: 'migrate.handler',
      msg: 'running migrations',
      database: process.env.databaseName,
      region: process.env.AWS_REGION ?? process.env.awsRegion,
    }),
  );

  await runMigrations();

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({ at: 'migrate.handler', msg: 'migrations applied' }),
  );

  return {
    PhysicalResourceId: physicalResourceId,
    Data: { migratedAt: new Date().toISOString() },
  };
};
