// A tiny build step: proves node, npm ci and the vendored tarball work, and writes an output file.
import { mkdirSync, writeFileSync } from 'node:fs';
import tiny from 'tiny-lib';

mkdirSync('public', { recursive: true });
writeFileSync('public/index.txt', tiny.greet('arco') + '\n');
console.log('fixture build done');
