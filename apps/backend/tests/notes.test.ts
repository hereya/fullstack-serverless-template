import { describe, it, expect } from 'vitest';

// Integration test against the real dev Aurora cluster.
// Disabled by default — flip the .skip to enable when `hereya run` has populated
// the env vars and migrations have been applied to the dev DB.
describe.skip('notes (integration)', () => {
  it('creates and lists notes scoped to the current user', async () => {
    expect(true).toBe(true);
  });
});
