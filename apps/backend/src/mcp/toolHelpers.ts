// Shared helpers for MCP tool implementations.
//
// Two concerns:
//   1. Map our AuthUser (set on the Hono Context by mcpAuth middleware
//      and forwarded into the MCP transport via `authInfo.extra.user`)
//      back into a per-tool permission check.
//   2. Adapt thrown handler-level errors (EmailAlreadyExistsError,
//      UserNotFoundError, LastAdminError, …) into the CallToolResult
//      shape MCP expects.
//
// Tools that just want "is the caller allowed + do the thing + return
// the result" should call `withPermission(...)` rather than rolling
// their own boilerplate.

import type { AuthUser } from '../middleware/auth.js';
import {
  roleHasPermission,
  type Permission,
} from '../auth/permissions.js';

interface ToolExtra {
  authInfo?: {
    extra?: Record<string, unknown>;
  };
}

// MCP CallToolResult shape (minimal subset we use). Documenting it
// locally avoids dragging in the SDK's generated types here, which
// makes the file readable as a reference for new tool authors.
export interface ToolResult {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  // Index signature lets ToolResult satisfy the MCP SDK's
  // CallToolResult contract (which expects `[x: string]: unknown`).
  // Without it, returning a ToolResult from a registered tool fails
  // typecheck against `@modelcontextprotocol/sdk`.
  [k: string]: unknown;
}

function errorResult(message: string): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

// Pulls the AuthUser the bearer-token middleware stashed in
// authInfo.extra. Returns the result-error if the user is missing
// (defensive — middleware should always set this) or lacks the
// required permission.
export async function withPermission<T>(
  extra: ToolExtra,
  permission: Permission,
  fn: (user: AuthUser) => Promise<T>,
): Promise<T | ToolResult> {
  const user = extra.authInfo?.extra?.user as AuthUser | undefined;
  if (!user) return errorResult('unauthorized');
  const ok = await roleHasPermission(user.roleName, permission);
  if (!ok) {
    return errorResult(
      `forbidden — your role does not have the '${permission}' permission`,
    );
  }
  try {
    return await fn(user);
  } catch (err) {
    return errorResult(
      err instanceof Error ? err.message : 'internal error',
    );
  }
}

// Build the success-shape return for a tool. The text block carries
// the summary AND the JSON payload — they are not redundant:
//
//   - `structuredContent` is consumed by hosts that render a UI
//     widget alongside the chat (Claude.ai web does this).
//   - `content[0].text` is what the LLM actually reads. Most hosts
//     DO NOT pipe `structuredContent` into the model. If the JSON
//     isn't here, the model sees only the summary ("Found 1 user")
//     and can't reason about the actual data.
//
// The MCP spec backs this: a tool returning structuredContent SHOULD
// also return functionally equivalent unstructured content. We do.
export function ok(
  data: Record<string, unknown>,
  summary?: string,
): ToolResult {
  const json = JSON.stringify(data, null, 2);
  const text = summary ? `${summary}\n\n${json}` : json;
  return {
    content: [{ type: 'text', text }],
    structuredContent: data,
  };
}
