// Shared user-management handlers, called from BOTH:
//   - apps/backend/src/routes/admin.ts (HTTP /api/admin/users)
//   - apps/backend/src/mcp/tools/users.ts (MCP users.* tools)
//
// Permission gating is the CALLER's responsibility — the HTTP route
// uses `requirePermission()` middleware, the MCP tool checks via
// `roleHasPermission()`. Both gates reference the same constants
// (USERS_LIST, USERS_ADD, USERS_SUSPEND) so the two surfaces can't
// drift. See docs/mcp.md and docs/adding-features.md for the
// "shared-handler + matching permission" convention.
//
// Handlers return plain serializable shapes (no Hono Response). The
// caller adapts: HTTP route wraps in `c.json(...)`; MCP tool wraps in
// the tool-result envelope.

import {
  addAllowlistedUser,
  countActiveAdmins,
  findUserById,
  listUsers,
  setSuspended,
  type UserRow,
} from '../../auth/users.js';
import { deleteUserSessions } from '../../auth/sessions.js';

// User shape exposed to both surfaces. Hides internal fields like
// cognitoSub; callers shouldn't need it.
export interface AdminUserView {
  id: string;
  email: string;
  roleName: string;
  suspended: boolean;
  hasSignedIn: boolean;
  createdAt: Date | string;
}

function toView(u: UserRow): AdminUserView {
  return {
    id: u.id,
    email: u.email,
    roleName: u.roleName,
    suspended: u.suspended,
    hasSignedIn: u.cognitoSub !== null,
    createdAt: u.createdAt,
  };
}

export async function listUsersHandler(): Promise<AdminUserView[]> {
  const rows = await listUsers();
  return rows.map(toView);
}

// Sentinel error so both adapters can map to the right surface-shaped
// error (HTTP 409, MCP InvalidRequest). Catching by class is cleaner
// than relying on .message regexes.
export class EmailAlreadyExistsError extends Error {
  constructor(email: string) {
    super(`a user with email ${email} already exists`);
    this.name = 'EmailAlreadyExistsError';
  }
}

export async function addUserHandler(email: string): Promise<AdminUserView> {
  try {
    const user = await addAllowlistedUser(email);
    return toView(user);
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (
      e.name === 'UserAlreadyExistsException' ||
      /already exists/i.test(e.message ?? '')
    ) {
      throw new EmailAlreadyExistsError(email);
    }
    throw err;
  }
}

// Errors that callers should surface as 4xx (not 500). Each adapter
// maps to its own status code; the handler only signals "this is the
// user's fault, not ours."
export class UserNotFoundError extends Error {
  constructor() {
    super('user not found');
    this.name = 'UserNotFoundError';
  }
}
export class LastAdminError extends Error {
  constructor() {
    super('cannot suspend the last active admin');
    this.name = 'LastAdminError';
  }
}

export async function setSuspendedHandler(
  userId: string,
  suspended: boolean,
): Promise<AdminUserView> {
  const target = await findUserById(userId);
  if (!target) throw new UserNotFoundError();

  // Safeguard: don't lock the system out of /api/admin/* by suspending
  // the last admin. Same check whether the request comes via HTTP or
  // MCP — that's the whole point of sharing the handler.
  if (suspended && target.roleName === 'admin' && !target.suspended) {
    const remaining = await countActiveAdmins({ excludeUserId: target.id });
    if (remaining === 0) throw new LastAdminError();
  }

  const updated = await setSuspended(userId, suspended);
  if (!updated) throw new UserNotFoundError();

  // Suspending → tear down active sessions so the change takes effect
  // on the next request. authMiddleware doesn't re-check user state
  // per request — the session row is the hot-path source of truth.
  if (suspended) {
    try {
      await deleteUserSessions(userId);
    } catch {
      // Best-effort: a transient DDB failure here shouldn't block the
      // suspension. Admin can retry the operation to re-enforce.
    }
  }

  return toView(updated);
}
