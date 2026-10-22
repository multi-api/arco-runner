import { build } from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Paths are relative to agent/, wherever the script is run from (CI and the README run it from the repo root).
const common = { bundle: true, platform: 'node', target: 'node24', format: 'esm', absWorkingDir: dirname(fileURLToPath(import.meta.url)) };
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/arco-runner.mjs' });
await build({ ...common, entryPoints: ['src/validate-cli.ts'], outfile: 'dist/validate-cli.mjs' });
