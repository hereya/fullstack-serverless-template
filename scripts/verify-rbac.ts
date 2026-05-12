#!/usr/bin/env tsx
//
// Smoke test for the DDB-backed RBAC setup. Run via:
//   hereya run -- npm run rbac:verify
//
// What it does:
//   1. Maps AWS_REGION from camelCase env (same as env.ts does).
//   2. Calls ensureDefaultRolesSeeded() → idempotent Put of admin + member
//      rows into authRolesTable.
//   3. Calls listRoles() → confirms the two rows are present with the
//      expected permission sets.
//   4. Calls bootstrapComplete() against authUsersTable to confirm the
//      table is reachable (returns false on an empty table).
//
// Exits non-zero on any failure. Safe to re-run any time.

process.env.AWS_REGION ||=
  process.env.awsRegion ?? process.env.awsCognitoRegion;

import { listRoles } from '../apps/backend/src/auth/roles.js';
import { ensureDefaultRolesSeeded } from '../apps/backend/src/auth/seedRoles.js';
import { bootstrapComplete } from '../apps/backend/src/auth/users.js';
import {
  ALL_PERMISSIONS,
  MEMBER_PERMISSIONS,
} from '../apps/backend/src/auth/permissions.js';

async function main(): Promise<void> {
  console.log('Verifying RBAC setup');
  console.log('====================');
  console.log(`Region: ${process.env.AWS_REGION}`);
  console.log(`authUsersTableName: ${process.env.authUsersTableName}`);
  console.log(`authRolesTableName: ${process.env.authRolesTableName}`);
  console.log('');

  console.log('Step 1: Seeding default roles (idempotent)...');
  await ensureDefaultRolesSeeded();
  console.log('  ✓ seed call returned');

  console.log('\nStep 2: Reading roles back from authRolesTable...');
  const roles = await listRoles();
  console.log(`  Found ${roles.length} role(s):`);
  for (const r of roles) {
    console.log(
      `    • ${r.roleName}: ${[...r.permissions].join(', ') || '(empty)'}`,
    );
  }

  const admin = roles.find((r) => r.roleName === 'admin');
  const member = roles.find((r) => r.roleName === 'member');

  if (!admin) throw new Error('admin role missing from authRolesTable');
  if (!member) throw new Error('member role missing from authRolesTable');

  for (const p of ALL_PERMISSIONS) {
    if (!admin.permissions.has(p)) {
      throw new Error(`admin role missing permission: ${p}`);
    }
  }
  for (const p of MEMBER_PERMISSIONS) {
    if (!member.permissions.has(p)) {
      throw new Error(`member role missing permission: ${p}`);
    }
  }
  if (member.permissions.has('users:list')) {
    throw new Error('member role unexpectedly has users:list');
  }
  console.log('  ✓ admin has all permissions');
  console.log('  ✓ member has notes-own permissions only');

  console.log('\nStep 3: Probing bootstrapComplete on authUsersTable...');
  const bootstrapped = await bootstrapComplete();
  console.log(`  ${bootstrapped ? '⚠️ ' : '✓ '}bootstrap sentinel ${
    bootstrapped ? 'EXISTS (first user has already signed up)' : 'absent (fresh state)'
  }`);

  console.log('\nDone. RBAC plumbing is working end-to-end.');
}

main().catch((err) => {
  console.error('\n❌ Verification failed:', err);
  process.exit(1);
});
