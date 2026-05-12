// Aggregate counts surfaced via the `stats_summary` MCP tool and
// (optionally — see TODO below) a future /api/admin/stats endpoint.
// Pure read; nothing here mutates state.

import { sql } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { dbCall } from '../../db/resilience.js';
import {
  noteAttachments,
  newsletterSubscriptions,
  notes,
} from '../../db/schema.js';
import { countUsers } from '../../auth/users.js';

export interface StatsSummary {
  userCount: number;
  noteCount: number;
  attachmentCount: number;
  subscriptionCount: number;
}

export async function statsSummaryHandler(): Promise<StatsSummary> {
  // Parallel-fetch every count. Aurora wakeup is absorbed by `dbCall`
  // resilience; the user-count lookup is on DDB (cheap).
  const [users, noteRows, attachmentRows, subRows] = await Promise.all([
    countUsers(),
    dbCall(
      () =>
        getDb()
          .select({ c: sql<number>`cast(count(*) as int)` })
          .from(notes),
      'stats.notes',
    ),
    dbCall(
      () =>
        getDb()
          .select({ c: sql<number>`cast(count(*) as int)` })
          .from(noteAttachments),
      'stats.attachments',
    ),
    dbCall(
      () =>
        getDb()
          .select({ c: sql<number>`cast(count(*) as int)` })
          .from(newsletterSubscriptions),
      'stats.subscriptions',
    ),
  ]);
  return {
    userCount: users,
    noteCount: noteRows[0]?.c ?? 0,
    attachmentCount: attachmentRows[0]?.c ?? 0,
    subscriptionCount: subRows[0]?.c ?? 0,
  };
}
