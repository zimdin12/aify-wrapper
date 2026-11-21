import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {ownerEnv, writePrivateCredential} from './private-credential.mjs';

const generator = new URL('../bin/aify-session-mcp.mjs', import.meta.url);
const KEY = 'fixture-only-api-key';

async function destination(t, prefix) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({path: request.url, key: request.headers['x-api-key'] ?? null});
    response.end('owned destination');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {port: server.address().port, requests, prefix};
}

function sessionConfig(home, endpoint, actual) {
  const services = [{name: 'owned-service', own: true, endpoint, credentialRef: 'owned.key', keyEnv: []}];
  const run = spawnSync(process.execPath, [fileURLToPath(generator)], {
    env: {...ownerEnv(), HOME: home, USERPROFILE: home, AIFY_AGENT_ID: 'owned-session',
      AIFY_SESSION_HTTP_B64: Buffer.from(JSON.stringify(services)).toString('base64'), AIFY_SESSION_ENDPOINT: actual},
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(fs.readFileSync(run.stdout.trim(), 'utf8')).mcpServers['owned-service'];
}

test('outbound HTTP keeps the stored key on the registered base', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aify-http-destination-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  writePrivateCredential(home, 'owned.key', KEY);
  const authorized = await destination(t, '/owned');
  const other = await destination(t, '/other');
  const registered = `http://localhost:${authorized.port}${authorized.prefix}`;
  const same = sessionConfig(home, registered, `http://127.0.0.1:${authorized.port}${authorized.prefix}`);
  const wrong = sessionConfig(home, registered, `http://127.0.0.1:${other.port}${other.prefix}`);
  for (const entry of [same, wrong]) {
    const response = await fetch(entry.url, {headers: entry.headers, redirect: 'error'});
    assert.equal(await response.text(), 'owned destination');
  }
  assert.deepEqual(authorized.requests, [{path: '/owned/mcp/http', key: KEY}], 'registered destination receives the stored key');
  assert.deepEqual(other.requests, [{path: '/other/mcp/http', key: null}], 'foreign destination receives no stored key');
});
