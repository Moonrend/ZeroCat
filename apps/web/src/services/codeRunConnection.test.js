import test from 'node:test';
import assert from 'node:assert/strict';
import {createCodeRunWebSocketOptions} from './codeRunConnection.js';

test('runner WebSocket transport keeps credentials out of URLs', () => {
  const capability = `zcr_${'a'.repeat(64)}`;
  const connection = createCodeRunWebSocketOptions(
    'https://user:password@runner.example/base?old=secret#fragment',
    capability,
    'https:'
  );

  assert.equal(connection.url, 'wss://runner.example/terminal');
  assert.equal(new URL(connection.url).search, '');
  assert.equal(connection.protocol, `zerocat-terminal-v1.${capability}`);
});

test('normal API access tokens cannot become runner capabilities', () => {
  const apiToken = `zc_${'b'.repeat(96)}`;
  assert.throws(
    () => createCodeRunWebSocketOptions('https://runner.example', apiToken, 'https:'),
    /Invalid CodeRun capability/
  );
});
