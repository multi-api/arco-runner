import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/arco-runner.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
});
