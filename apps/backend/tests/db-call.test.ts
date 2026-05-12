import { describe, it, expect, vi } from 'vitest';
import { dbCall, isTransient } from '../src/db/resilience.js';

// Mirrors the shape AWS SDK + Drizzle hand us when Aurora is paused.
function transientErr(): Error {
  const err = new Error('DrizzleQueryError: Failed query');
  (err as { cause?: unknown }).cause = Object.assign(
    new Error('Aurora DB instance is resuming after being auto-paused.'),
    { name: 'DatabaseResumingException' },
  );
  return err;
}

describe('isTransient', () => {
  it('matches by error name', () => {
    expect(
      isTransient(
        Object.assign(new Error('x'), { name: 'DatabaseResumingException' }),
      ),
    ).toBe(true);
    expect(
      isTransient(
        Object.assign(new Error('x'), { name: 'ThrottlingException' }),
      ),
    ).toBe(true);
  });

  it('matches by message pattern', () => {
    expect(isTransient(new Error('cluster is currently resuming'))).toBe(true);
    expect(isTransient(new Error('totally unrelated'))).toBe(false);
  });

  it('walks .cause chains (Drizzle wraps the underlying SDK error)', () => {
    expect(isTransient(transientErr())).toBe(true);
  });
});

describe('dbCall', () => {
  it('does not call warmup on the happy path', async () => {
    const warmup = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await dbCall(fn, 'happy', warmup);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(warmup).not.toHaveBeenCalled();
  });

  it('on transient error: warms cluster, retries the query once, returns success', async () => {
    const warmup = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw transientErr();
      return 'ok';
    });
    const result = await dbCall(fn, 'retry-then-ok', warmup);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(warmup).toHaveBeenCalledTimes(1);
  });

  it('on transient error: gives up after one retry if it still fails', async () => {
    const warmup = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn(async () => {
      throw transientErr();
    });
    await expect(dbCall(fn, 'give-up', warmup)).rejects.toThrow(
      /DrizzleQueryError/,
    );
    expect(fn).toHaveBeenCalledTimes(2); // initial + 1 retry after warmup
    expect(warmup).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a non-transient error', async () => {
    const warmup = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn(async () => {
      throw new Error('schema mismatch');
    });
    await expect(dbCall(fn, 'no-retry', warmup)).rejects.toThrow(
      /schema mismatch/,
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(warmup).not.toHaveBeenCalled();
  });

  it('rethrows warmup failure if warmup itself fails', async () => {
    const warmup = vi.fn().mockRejectedValue(new Error('warmup exhausted'));
    const fn = vi.fn(async () => {
      throw transientErr();
    });
    await expect(dbCall(fn, 'warmup-fails', warmup)).rejects.toThrow(
      /warmup exhausted/,
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(warmup).toHaveBeenCalledTimes(1);
  });
});
