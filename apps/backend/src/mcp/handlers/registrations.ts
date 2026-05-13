// Shared registration read/write handlers (admin only, by permission).
// Same shared-handler convention as users.ts — both the HTTP route and
// the MCP tool call into this module.
//
// Replaces the previous Aurora-backed subscriptions handler. The store
// (auth/registrationsStore.ts) is schema-less, so a row carries email +
// createdAt at minimum plus whatever custom fields the project's
// registration form captured.

import {
  listRegistrations,
  removeRegistration,
  type Registration,
} from '../../auth/registrationsStore.js';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export class RegistrationNotFoundError extends Error {
  constructor(email: string) {
    super(`registration not found: ${email}`);
    this.name = 'RegistrationNotFoundError';
  }
}

export async function listRegistrationsHandler(
  opts: { limit?: number } = {},
): Promise<Registration[]> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  return listRegistrations(limit);
}

export async function deleteRegistrationHandler(email: string): Promise<void> {
  // We don't surface "not found" as a hard error — idempotent delete is
  // the better UX. Callers that need stricter semantics can pre-fetch
  // via getRegistration() and 404 themselves.
  await removeRegistration(email);
}
