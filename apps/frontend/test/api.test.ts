import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../src/lib/api';

const CACHE_KEY = 'hereya_authnav_v1';

describe('api fetch wrapper', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('clears the AuthNav cache when the API returns 401', async () => {
    // Simulate a previously-cached "user" state.
    sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        state: 'user',
        user: { id: 'u1', email: 'alice@example.com', roleName: 'admin' },
        fetchedAt: Date.now(),
      }),
    );
    expect(sessionStorage.getItem(CACHE_KEY)).not.toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'unauthenticated' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(api('/api/notes')).rejects.toThrow(/401/);

    // After the 401 round-trip the AuthNav cache should be wiped so the
    // next mount lands on the anon state cleanly (no Dashboard flicker).
    expect(sessionStorage.getItem(CACHE_KEY)).toBeNull();
  });

  it('does NOT clear the cache on 2xx responses', async () => {
    sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        state: 'user',
        user: { id: 'u1', email: 'alice@example.com', roleName: 'admin' },
        fetchedAt: Date.now(),
      }),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const result = await api<{ ok: boolean }>('/api/notes');
    expect(result).toEqual({ ok: true });
    expect(sessionStorage.getItem(CACHE_KEY)).not.toBeNull();
  });

  it('does NOT clear the cache on 4xx responses other than 401', async () => {
    sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        state: 'user',
        user: { id: 'u1', email: 'alice@example.com', roleName: 'admin' },
        fetchedAt: Date.now(),
      }),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'forbidden' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(api('/api/admin/users')).rejects.toThrow(/403/);
    // A 403 means "the user IS signed in but isn't permitted" — the auth
    // cache is still valid, no reason to invalidate.
    expect(sessionStorage.getItem(CACHE_KEY)).not.toBeNull();
  });

  it('always sends credentials: include + JSON content-type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api('/api/anything');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/anything',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      }),
    );
  });
});
