// Shared fetch wrapper for /api/* calls. Cookies ride along (credentials:
// 'include' so the dev-server proxy preserves the hereya_sid cookie).
//
// Side-effect on 401: nuke the auth cache (lib/authState). Any auth-gated
// request that comes back unauthenticated is a strong signal that the
// user's session is gone server-side; we don't want the next page
// navigation to keep showing Dashboard / Admin from a stale cache. The
// AuthNav island re-fetches on its next mount and lands on the anon
// state cleanly.
import { clearAuthCache } from './authState';

// Structured error type so callers can render friendly UX instead of
// shoving raw "401 Unauthorized" / "500 Internal Server Error" strings
// in front of users. Backwards-compatible: `.message` keeps the
// "<status> <statusText>" format that older `msg.startsWith('401')`
// checks rely on; new code should prefer `err.status` directly.
export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  // Parsed JSON body if the response was JSON, otherwise the raw text.
  // Always check shape before using — servers can return any payload.
  readonly body: unknown;

  constructor(status: number, statusText: string, body: unknown) {
    super(`${status} ${statusText}`);
    this.name = 'ApiError';
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }

  // Pull a `{ error: string }` field off the body if present — the
  // backend convention. Falls back to undefined so callers can decide
  // whether to use it or a hand-rolled friendly message instead.
  get serverMessage(): string | undefined {
    if (
      typeof this.body === 'object' &&
      this.body !== null &&
      'error' in this.body &&
      typeof (this.body as { error: unknown }).error === 'string'
    ) {
      return (this.body as { error: string }).error;
    }
    return undefined;
  }
}

// Generic error → user-facing string mapper. Surfaces no raw status
// codes. Callers pass a `fallback` describing the action that failed
// ("Failed to load notes", "Couldn't save your note") which is used as
// a last-resort message when the error shape is unknown. Auth flows
// often want their own context-specific phrasing — see
// `friendlyLoginError` in LoginForm.ts for an example of how to layer
// per-screen messages on top of this.
export function friendlyError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return 'Your session expired. Please sign in again.';
    }
    if (err.status === 403) {
      return "You don't have permission to do that.";
    }
    if (err.status === 404) {
      return "We couldn't find what you were looking for.";
    }
    if (err.status === 429) {
      return 'Too many requests — please slow down and try again in a moment.';
    }
    if (err.status === 400) {
      // Server's `{ error: "..." }` is usually a validation hint here,
      // which is genuinely useful to surface.
      return err.serverMessage ?? 'Please check your input and try again.';
    }
    if (err.status >= 500) {
      return 'Something went wrong on our end. Please try again in a moment.';
    }
  }
  if (err instanceof TypeError) {
    // fetch throws TypeError on network failures (CORS, offline, DNS).
    return "We couldn't reach the server. Check your connection and try again.";
  }
  return fallback;
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  if (res.status === 401) {
    clearAuthCache();
  }
  if (!res.ok) {
    // Best-effort parse of the error body. Servers usually return JSON
    // with { error: "..." } here; treat parse failures as missing body.
    let body: unknown = null;
    try {
      body = res.headers.get('content-type')?.includes('json')
        ? await res.json()
        : await res.text();
    } catch {
      // ignore
    }
    throw new ApiError(res.status, res.statusText, body);
  }
  return (
    res.headers.get('content-type')?.includes('json')
      ? res.json()
      : (res.text() as unknown)
  ) as T;
}
