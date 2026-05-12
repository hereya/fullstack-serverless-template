// Shared retry / warmup helpers for Aurora Serverless v2 + Data API.
//
// Why this exists: Aurora Serverless v2 auto-pauses when idle. The first Data
// API call against a paused cluster returns DatabaseResumingException (and
// related transient errors). The AWS SDK marks these with $retryable: undefined
// so its built-in retry layer does NOT retry them, and Drizzle wraps them in
// a generic DrizzleQueryError so even tools that inspect err.name miss the
// underlying error. We add explicit retry here, with a recursive
// isTransient() that walks .cause chains.
//
// Used by:
//   - src/db/migrator.ts            (deploy-time + dev migrations)
//   - src/handler.ts                (Lambda cold-start warmup)
//   - src/middleware/db-retry.ts    (per-request retry of /api/* handlers)

import {
  RDSDataClient,
  ExecuteStatementCommand,
} from '@aws-sdk/client-rds-data';

const TRANSIENT_ERROR_NAMES = new Set([
  'DatabaseResumingException',
  'DatabaseNotFoundException',
  'ServiceUnavailableException',
  'ThrottlingException',
  'TooManyRequestsException',
  'InternalServerErrorException',
]);

const TRANSIENT_MESSAGE_PATTERNS: RegExp[] = [
  /currently resuming/i,
  /currently scaling/i,
  /is paused/i,
  /not currently available/i,
  /communications link failure/i,
];

export function isTransient(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string; cause?: unknown };
  if (e.name && TRANSIENT_ERROR_NAMES.has(e.name)) return true;
  const msg = e.message ?? '';
  if (TRANSIENT_MESSAGE_PATTERNS.some((p) => p.test(msg))) return true;
  // Drizzle wraps the original Data API error inside `cause`. Recurse so we
  // catch the underlying DatabaseResumingException even when the visible error
  // is a generic DrizzleQueryError.
  if (e.cause) return isTransient(e.cause);
  return false;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export interface RetryOpts {
  label?: string;
  maxAttempts?: number;
  baseMs?: number;
  capMs?: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  {
    label = 'rds-data call',
    maxAttempts = 6,
    baseMs = 1500,
    capMs = 8000,
  }: RetryOpts = {},
): Promise<T> {
  let attempt = 0;
  let lastErr: unknown;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) throw err;
      attempt += 1;
      if (attempt >= maxAttempts) break;
      const expDelay = Math.min(capMs, baseMs * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 300);
      const delay = expDelay + jitter;
      const e = err as { name?: string; message?: string };
      // eslint-disable-next-line no-console
      console.log(
        `[db-resilience] ${label} failed with transient ${
          e.name ?? 'error'
        }: ${e.message ?? ''}. Retrying in ${delay}ms (attempt ${attempt}/${maxAttempts}).`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

// Wraps a single Drizzle / Data API call so it survives Aurora Serverless v2
// pause/resume. Strategy:
//
//   1. Run the query once. If it succeeds, return — zero overhead in the
//      common case where the cluster is awake.
//   2. If it throws a transient error (DatabaseResumingException etc.),
//      delegate to warmupCluster() which has a generous retry budget
//      (~110s worst case) to wait for the cluster to come up.
//   3. Once warmupCluster() succeeds, retry the query ONCE. Side effects
//      are bounded: the first attempt was rejected at the AWS SDK boundary
//      before any DB write, and the retry runs against a now-awake cluster.
//
// This means a single user-facing request can take up to ~110s + 2× query
// time in the pathological "cluster fully paused, never woken" case. In
// Lambda that's longer than the default 30s timeout, but the Lambda cold-
// start warmup (handler.ts) already pre-wakes the cluster before any user
// request runs. In dev, dev-server.ts does the same at startup. So this
// path is only hit for in-flight requests when the cluster pauses mid-life.
//
// Wrap each Drizzle terminal call site individually:
//   const rows = await dbCall(() => db.select().from(notes).where(...));
export async function dbCall<T>(
  fn: () => Promise<T>,
  label?: string,
  // Dependency-injection seam for tests. ESM modules resolve internal
  // references to functions at bind time, so vi.spyOn can't replace
  // warmupCluster for an internal-to-module call. Tests pass a stub.
  warmup: () => Promise<void> = warmupCluster,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransient(err)) throw err;
    const e = err as { name?: string; message?: string };
    // eslint-disable-next-line no-console
    console.log(
      `[db-call] ${label ?? 'call'} hit transient ${
        e.name ?? 'error'
      }: ${e.message ?? ''}. Warming cluster and retrying...`,
    );
    await warmup();
    return await fn();
  }
}

// One-shot wakeup with a generous retry budget (~110s worst case). Issued via
// RDSDataClient directly so it doesn't depend on Drizzle being initialized.
// Caller should invoke this from module init / handler init so the first
// real query runs against an awake cluster.
export async function warmupCluster(): Promise<void> {
  const region = process.env.AWS_REGION ?? process.env.awsRegion;
  const rds = new RDSDataClient({ region });
  await withRetry(
    () =>
      rds.send(
        new ExecuteStatementCommand({
          resourceArn: process.env.clusterArn,
          secretArn: process.env.secretArn,
          database: process.env.databaseName,
          sql: 'SELECT 1',
        }),
      ),
    { label: 'warmup SELECT 1', maxAttempts: 12, baseMs: 2000, capMs: 15000 },
  );
}
