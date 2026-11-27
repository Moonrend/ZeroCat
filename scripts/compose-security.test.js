import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const applicationCompose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
const postgresCompose = readFileSync(new URL('../docker/postgres/docker-compose.yml', import.meta.url), 'utf8');

function declarationsFor(source, name) {
    return source
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.startsWith(`${name}:`));
}

test('application compose requires an external database URL', () => {
    assert.deepEqual(declarationsFor(applicationCompose, 'DATABASE_URL'), [
        'DATABASE_URL: ${DATABASE_URL:?DATABASE_URL must be set to a dedicated PostgreSQL application role}',
    ]);
    assert.doesNotMatch(applicationCompose, /\b(?:mysql|postgres(?:ql)?):\/\/[^${\s"']+/i);
});

test('PostgreSQL compose requires a unique password and publishes only to loopback', () => {
    assert.deepEqual(declarationsFor(postgresCompose, 'POSTGRES_PASSWORD'), [
        'POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set to a unique value}',
    ]);

    const publishedDatabasePorts = postgresCompose
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => /^-\s*["']?.*:5432["']?$/.test(line));

    assert.deepEqual(publishedDatabasePorts, [
        '- "127.0.0.1:${POSTGRES_PORT:-5432}:5432"',
    ]);
});
