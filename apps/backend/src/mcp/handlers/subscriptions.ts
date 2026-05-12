// Shared newsletter-subscription read handlers (admin only, by
// permission). Same shared-handler convention as users.ts — both the
// HTTP route and the MCP tool call into this module.

import { desc } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { dbCall } from '../../db/resilience.js';
import { newsletterSubscriptions } from '../../db/schema.js';

export interface SubscriptionView {
  id: string;
  email: string;
  createdAt: Date | string;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export async function listSubscriptionsHandler(opts: {
  limit?: number;
} = {}): Promise<SubscriptionView[]> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const rows = await dbCall(
    () =>
      getDb()
        .select()
        .from(newsletterSubscriptions)
        .orderBy(desc(newsletterSubscriptions.createdAt))
        .limit(limit),
    'admin.subscriptions.list',
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    createdAt: r.createdAt,
  }));
}
