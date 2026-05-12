import esbuild from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';

// Two entrypoints:
//   - handler.ts  → dist/handler.js   (main app Lambda, Hono on aws-lambda)
//   - migrate.ts  → dist/migrate.js   (migration Lambda invoked by CFn Custom Resource)
// Both share the same bundle deps and ship together inside dist/.
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
