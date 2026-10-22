// Runs the /validate canned job once and exits 0 or 1: the image smoke test without the hooks server
// (`docker run --network none --user 0 image node /opt/arco-runner/validate-cli.mjs`).
import { join } from 'node:path';
import { buildIdentity, defaultPaths } from './system.js';
import { runValidation } from './validate.js';

const paths = defaultPaths();
const started = Date.now();
runValidation({ paths, identity: buildIdentity(), fixtureDir: join(paths.agentDir, 'fixture') }).then(
  () => console.log(`validation passed in ${((Date.now() - started) / 1000).toFixed(1)}s`),
  (e) => {
    console.error(`validation failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
