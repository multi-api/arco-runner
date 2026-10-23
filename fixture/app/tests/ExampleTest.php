<?php
// Run by the fake PHPUnit (packages/fake-phpunit) in the first /validate job: the test environment, not the build's.
return [
    'runs in the test environment' => function (): void {
        if (getenv('APP_ENV') !== 'testing') {
            throw new RuntimeException('APP_ENV is not testing');
        }
        if (! str_starts_with((string) getenv('APP_KEY'), 'base64:')) {
            throw new RuntimeException('no APP_KEY');
        }
    },
    'has no AWS credentials' => function (): void {
        foreach (['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'] as $name) {
            if (getenv($name) !== false) {
                throw new RuntimeException("{$name} is set");
            }
        }
    },
];
