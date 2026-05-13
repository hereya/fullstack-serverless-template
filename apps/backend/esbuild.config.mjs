import esbuild from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';

// Two Lambda entrypoints:
//   - handler.ts  → dist/handler.js   (main app Lambda, Hono on aws-lambda)
//   - migrate.ts  → dist/migrate.js   (no-op migration Lambda; hereya/
//                                      aws-app-lambda's Custom Resource
//                                      requires it to exist even when
//                                      there's no Aurora schema)
//
// The minimal template's migrate.ts is a no-op (returns success without
// running anything). Patterns that add Aurora (e.g. the notes pattern
// in docs/patterns/notes.md) replace its contents with a real migrator.
await esbuild.build({
  entryPoints: ['src/handler.ts', 'src/migrate.ts'],
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
