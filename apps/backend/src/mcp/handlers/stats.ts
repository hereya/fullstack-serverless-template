// Aggregate counts surfaced via the `stats_summary` MCP tool and the
// admin /stats endpoint. Pure reads; nothing here mutates state.
//
// The minimal template ships only two countable resources: users (DDB
// authUsersTable) and registrations (DDB registrationsTable). Aurora-
// backed entities (e.g. notes) are added by the notes pattern doc; if
// you apply that pattern, extend the summary here too.

import { countUsers } from '../../auth/users.js';
import { countRegistrations } from '../../auth/registrationsStore.js';

export interface StatsSummary {
  userCount: number;
  registrationCount: number;
  // Index signature so this satisfies the MCP SDK's structuredContent
  // contract (`Record<string, unknown>`).
  [k: string]: unknown;
}

export async function statsSummaryHandler(): Promise<StatsSummary> {
  const [userCount, registrationCount] = await Promise.all([
    countUsers(),
    countRegistrations(),
  ]);
  return { userCount, registrationCount };
}
