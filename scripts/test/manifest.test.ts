import { describe, expect, it } from 'vitest';
import { newestForMinor, parseManifest } from '../lib/manifest.ts';

const url = (r: string) => `https://github.com/multi-api/arco-runtime/releases/download/${r}/frankenphp-linux-aarch64`;
const source = `<?php
return [
    'default_php' => '8.5',
    'builds' => [
        'php8.4.9-fp1.12.0-r1' => [
            'url' => '${url('frankenphp-1.12.0-r1')}',
            'php' => '8.4.9',
        ],
        'php8.5.11-fp1.13.0-r1' => [
            'url' => '${url('frankenphp-1.13.0-r1')}',
            'php' => '8.5.11',
        ],
        'php8.5.12-fp1.13.1-r1' => [
            'url' => '${url('frankenphp-1.13.1-r1')}',
            'php' => '8.5.12',
            'php_cli' => [
                'url' => 'x',
            ],
        ],
    ],
    'aliases' => [],
];`;

describe('manifest', () => {
  it('picks the newest build of the minor that has a php_cli', () => {
    const build = newestForMinor(parseManifest(source), '8.5');
    expect(build).toMatchObject({ id: 'php8.5.12-fp1.13.1-r1', release: 'frankenphp-1.13.1-r1', php: '8.5.12' });
  });

  it('fails when the minor has no usable build', () => {
    expect(() => newestForMinor(parseManifest(source), '8.4')).toThrow(/no build of PHP 8.4/);
  });
});
