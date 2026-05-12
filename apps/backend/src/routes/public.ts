import { Hono } from 'hono';

export const publicRoutes = new Hono();

publicRoutes.get('/hello', (c) => c.json({ ok: true, ts: Date.now() }));
