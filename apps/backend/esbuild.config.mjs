import esbuild from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';

// Single Lambda entrypoint:
//   - handler.ts  → dist/handler.js   (main app Lambda, Hono on aws-lambda)
//
// The minimal template doesn't ship a migration Lambda — there's no
// Aurora schema to migrate. Patterns that add Aurora (e.g. the notes
// pattern in docs/patterns/notes.md) re-introduce a migrate.ts here
// and add it to the entrypoints list.
await esbuild.build({
  entryPoints: ['src/handler.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['@aws-sdk/*'],
  sourcemap: true,
  minify: false,
});

// The repo's apps/backend has `type: module`, but the bundles are CJS.
// Drop a tiny package.json into dist/ so Node treats .js inside dist/ as CommonJS
// (matches the format esbuild produced). The Lambda runtime reads this too.
mkdirSync('dist', { recursive: true });
writeFileSync('dist/package.json', JSON.stringify({ type: 'commonjs' }, null, 2));
