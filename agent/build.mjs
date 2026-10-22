import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node24', format: 'esm' };
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/arco-runner.mjs' });
await build({ ...common, entryPoints: ['src/validate-cli.ts'], outfile: 'dist/validate-cli.mjs' });
