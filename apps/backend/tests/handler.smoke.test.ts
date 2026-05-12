import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_HANDLER = path.resolve(__dirname, '..', 'dist', 'handler.js');

const hasBuild = existsSync(DIST_HANDLER);

const maybe = hasBuild ? describe : describe.skip;

maybe('handler smoke', () => {
  it('responds 200 to GET /api/hello via APIGW v2 event', async () => {
    // The bundled handler is CJS (`format: 'cjs'`), so use createRequire to load it
    // from this ESM test file.
    const require = createRequire(import.meta.url);
    const mod: { handler: (e: unknown, c: unknown) => Promise<unknown> } = require(DIST_HANDLER);

    const event = {
      version: '2.0',
      routeKey: 'GET /api/hello',
      rawPath: '/api/hello',
      rawQueryString: '',
      headers: { 'content-type': 'application/json' },
      requestContext: {
        http: { method: 'GET', path: '/api/hello', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1' },
        stage: '$default',
      },
      isBase64Encoded: false,
    };
    const result = (await mod.handler(event, {})) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).ok).toBe(true);
  });
});
